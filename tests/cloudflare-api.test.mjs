import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleDownload } from "../functions/api/download/[architecture].ts"
import { handleWaitlist } from "../functions/api/waitlist.ts"
import { ACCESS_COOKIE, createAccessToken } from "../lib/download-auth.ts"
import { DOWNLOAD_FILES } from "../lib/download-files.ts"
import { allowPasswordAttempt } from "../lib/download-rate-limit.ts"

let platform
let env
const password = "test-password-🗝️"
const bytes = new TextEncoder().encode("installer fixture bytes")
const origin = "https://photodepot.app"

before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = { ...platform.env, PHOTODEPOT_DOWNLOAD_PASSWORD: password }
  const migration = await readFile(
    new URL("../migrations/0001_waitlist.sql", import.meta.url),
    "utf8"
  )
  await env.DB.batch(
    unstable_splitSqlQuery(migration).map((sql) => env.DB.prepare(sql))
  )
  for (const name of Object.values(DOWNLOAD_FILES))
    await env.DOWNLOADS.put(name, bytes)
})
after(async () => {
  await platform?.dispose()
})

function request(path, method = "GET", body, extra = {}) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      "cf-connecting-ip": path,
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
function download(
  method = "GET",
  extra = {},
  body,
  bindings = env,
  architecture = "arm64"
) {
  return handleDownload(
    request(`/api/download/${architecture}`, method, body, extra),
    bindings,
    architecture
  )
}
const access = (
  architecture = "arm64",
  secret = password,
  now = Date.now()
) => ({
  cookie: `${ACCESS_COOKIE}=${createAccessToken(architecture, secret, now)}`,
})

test("private R2 downloads issue secure scoped cookies and stream exact bytes", async () => {
  for (const architecture of ["arm64", "x64"]) {
    const unlocked = await download("POST", {}, { password }, env, architecture)
    assert.equal(unlocked.status, 200)
    assert.deepEqual(await unlocked.json(), { ok: true })
    const cookie = unlocked.headers.get("set-cookie")
    for (const attribute of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Max-Age=300",
      `Path=/api/download/${architecture}`,
    ])
      assert.ok(cookie.includes(attribute), attribute)
    const response = await download(
      "GET",
      { cookie: cookie.split(";")[0] },
      undefined,
      env,
      architecture
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-length"), String(bytes.length))
    assert.ok(
      response.headers
        .get("content-disposition")
        .includes(DOWNLOAD_FILES[architecture])
    )
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  }
})

test("HEAD, single ranges, invalid ranges and If-Range follow download semantics", async () => {
  const head = await download("HEAD", access())
  assert.equal(head.status, 200)
  assert.equal(head.headers.get("content-length"), String(bytes.length))
  assert.equal(await head.text(), "")
  for (const [range, expected] of [
    ["bytes=2-5", bytes.slice(2, 6)],
    ["bytes=2-", bytes.slice(2)],
    ["bytes=-5", bytes.slice(-5)],
  ]) {
    const response = await download("GET", { ...access(), range })
    assert.equal(response.status, 206)
    assert.equal(
      Number(response.headers.get("content-length")),
      expected.length
    )
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected)
    assert.ok(
      response.headers.get("content-range").endsWith(`/${bytes.length}`)
    )
  }
  const invalid = await download("GET", { ...access(), range: "bytes=999-" })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get("content-range"), `bytes */${bytes.length}`)
  const changed = await download("GET", {
    ...access(),
    range: "bytes=0-1",
    "if-range": '"old-version"',
  })
  assert.equal(changed.status, 200)
  assert.deepEqual(new Uint8Array(await changed.arrayBuffer()), bytes)
})

test("missing, forged, expired, rotated and wrong-architecture tokens fail closed", async () => {
  for (const headers of [
    {},
    { cookie: `${ACCESS_COOKIE}=forged` },
    access("x64"),
    access("arm64", "old-password"),
    access("arm64", password, Date.now() - 300_000),
  ]) {
    const response = await download("GET", headers)
    assert.equal(response.status, 303)
    assert.equal(
      response.headers.get("location"),
      `${origin}/tester?download=locked`
    )
  }
  assert.equal(
    (await download("GET", access(), undefined, env, "invalid")).status,
    404
  )
  assert.equal((await download("PUT", access())).status, 405)
  assert.equal(
    (await download("POST", { origin: "https://other.example" }, { password }))
      .status,
    403
  )
  assert.equal(
    (
      await download(
        "POST",
        { "cf-connecting-ip": "wrong-password" },
        { password: "wrong" }
      )
    ).status,
    401
  )
  assert.equal(
    (
      await download(
        "POST",
        {},
        { password },
        { ...env, PHOTODEPOT_DOWNLOAD_PASSWORD: "" }
      )
    ).status,
    503
  )
})

test("D1 limiter is shared, atomic under concurrency, expires and hides raw IPs", async () => {
  const now = 1_800_000_000_000
  const allowed = await Promise.all(
    Array.from({ length: 12 }, () =>
      allowPasswordAttempt(env.DB, "198.51.100.9", password, now)
    )
  )
  assert.equal(allowed.filter(Boolean).length, 8)
  assert.equal(
    await allowPasswordAttempt(env.DB, "198.51.100.9", password, now + 599_999),
    false
  )
  assert.equal(
    await allowPasswordAttempt(env.DB, "198.51.100.9", password, now + 600_000),
    true
  )
  const rows = await env.DB.prepare("SELECT key FROM download_attempts").all()
  assert.ok(rows.results.every((row) => /^[a-f0-9]{64}$/.test(row.key)))
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await download(
          "POST",
          { "cf-connecting-ip": "limited" },
          { password: "wrong" }
        )
      ).status,
      401
    )
  const response = await download(
    "POST",
    { "cf-connecting-ip": "limited" },
    { password }
  )
  assert.equal(response.status, 429)
  assert.equal(response.headers.get("retry-after"), "600")
})

test("waitlist validates requests, persists answers in D1 and keeps the original duplicate", async () => {
  const entry = {
    firstName: "O'Connor",
    email: " ALEX@Example.com ",
    heardAboutUs: "Friend's post; DROP TABLE waitlist;",
  }
  const submit = (body, headers = {}, bindings = env) =>
    handleWaitlist(request("/api/waitlist", "POST", body, headers), bindings)
  assert.equal((await submit(entry)).status, 200)
  assert.equal((await submit({ ...entry, firstName: "Changed" })).status, 200)
  const row = await env.DB.prepare("SELECT * FROM waitlist WHERE email = ?")
    .bind("alex@example.com")
    .first()
  assert.equal(row.first_name, "O'Connor")
  assert.equal(row.last_name, null)
  assert.equal(row.heard_about_us, entry.heardAboutUs)
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T.+Z$/)
  assert.equal((await submit({})).status, 400)
  assert.equal(
    (await submit(entry, { origin: "https://other.example" })).status,
    403
  )
  assert.equal(
    (await submit(entry, { "content-type": "text/plain" })).status,
    415
  )
  assert.equal(
    (await submit({ ...entry, heardAboutUs: "x".repeat(9000) })).status,
    413
  )
  assert.equal((await submit(entry, {}, { ...env, DB: undefined })).status, 503)
  assert.equal(
    (await handleWaitlist(request("/api/waitlist"), env)).status,
    405
  )
})

test("malformed bodies and unavailable R2/D1 never authorize downloads", async () => {
  const malformed = new Request(`${origin}/api/download/arm64`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "cf-connecting-ip": "malformed",
    },
    body: "{",
  })
  assert.equal((await handleDownload(malformed, env, "arm64")).status, 400)
  assert.equal(
    (
      await download(
        "POST",
        { "cf-connecting-ip": "too-large" },
        { password: "x".repeat(9000) }
      )
    ).status,
    413
  )
  assert.equal(
    (await download("POST", {}, { password }, { ...env, DB: undefined }))
      .status,
    503
  )
  await env.DOWNLOADS.delete(DOWNLOAD_FILES.x64)
  assert.equal(
    (
      await download(
        "POST",
        { "cf-connecting-ip": "missing-file" },
        { password },
        env,
        "x64"
      )
    ).status,
    503
  )
  assert.equal(
    (await download("GET", access("x64"), undefined, env, "x64")).headers.get(
      "location"
    ),
    `${origin}/tester?download=unavailable`
  )
  await env.DOWNLOADS.put(DOWNLOAD_FILES.x64, "")
  assert.equal(
    (
      await download(
        "POST",
        { "cf-connecting-ip": "empty-file" },
        { password },
        env,
        "x64"
      )
    ).status,
    503
  )
})
