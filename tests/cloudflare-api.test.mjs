import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { after, before, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleDownload } from "../functions/api/download/[architecture].ts"
import { handleWaitlist } from "../functions/api/waitlist.ts"
import { DOWNLOAD_FILES } from "../lib/download-files.ts"

let platform
let env
const bytes = new TextEncoder().encode("installer fixture bytes")
const origin = "https://photodepot.app"

before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = platform.env
  for (const filename of (
    await readdir(new URL("../migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const migration = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8"
    )
    await env.DB.batch(
      unstable_splitSqlQuery(migration).map((sql) => env.DB.prepare(sql))
    )
  }
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
  bindings = env,
  architecture = "arm64"
) {
  return handleDownload(
    request(`/api/download/${architecture}`, method, undefined, extra),
    bindings,
    architecture
  )
}

function assertUnavailable(response) {
  assert.equal(response.status, 303)
  assert.equal(
    response.headers.get("location"),
    `${origin}/tester?download=unavailable`
  )
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.equal(response.headers.get("content-disposition"), null)
  assert.equal(response.headers.get("content-range"), null)
  assert.equal(response.headers.get("set-cookie"), null)
}

test("both installers stream publicly with HEAD and byte-range support", async () => {
  for (const architecture of ["arm64", "x64"]) {
    const full = await download("GET", {}, env, architecture)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get("content-length"), String(bytes.length))
    assert.equal(
      full.headers.get("content-disposition"),
      `attachment; filename="${DOWNLOAD_FILES[architecture]}"`
    )
    assert.equal(full.headers.get("cache-control"), "private, no-store")
    assert.equal(full.headers.get("set-cookie"), null)
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes)
    const head = await download(
      "HEAD",
      { range: "bytes=2-5" },
      env,
      architecture
    )
    assert.equal(head.status, 200)
    assert.equal(head.headers.get("content-length"), String(bytes.length))
    assert.equal(await head.text(), "")
    for (const [range, offset, length] of [
      ["bytes=2-5", 2, 4],
      ["bytes=2-", 2, bytes.length - 2],
      ["bytes=-5", bytes.length - 5, 5],
    ]) {
      const response = await download("GET", { range }, env, architecture)
      assert.equal(response.status, 206)
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${offset}-${offset + length - 1}/${bytes.length}`
      )
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        bytes.slice(offset, offset + length)
      )
    }
    const invalid = await download(
      "GET",
      { range: "bytes=999-" },
      env,
      architecture
    )
    assert.equal(invalid.status, 416)
    assert.equal(
      invalid.headers.get("content-range"),
      `bytes */${bytes.length}`
    )
    const stale = await download(
      "GET",
      { range: "bytes=0-1", "if-range": '"old-version"' },
      env,
      architecture
    )
    assert.equal(stale.status, 200)
    assert.deepEqual(new Uint8Array(await stale.arrayBuffer()), bytes)
  }
})

test("missing, empty, changed, and unreachable installers show the unavailable notice", async () => {
  const metadata = await env.DOWNLOADS.head(DOWNLOAD_FILES.arm64)
  const failed = {
    DOWNLOADS: {
      head: () => {
        throw new Error("Storage unavailable")
      },
    },
  }
  for (const bindings of [
    {},
    failed,
    { DOWNLOADS: { head: async () => null } },
    { DOWNLOADS: { head: async () => ({ size: 0 }) } },
  ]) {
    for (const architecture of ["arm64", "x64"]) {
      for (const method of ["GET", "HEAD"]) {
        for (const headers of [{}, { range: "bytes=0-1" }]) {
          const response = await download(
            method,
            headers,
            bindings,
            architecture
          )
          assertUnavailable(response)
          assert.equal(await response.text(), "")
        }
      }
    }
  }
  for (const object of [null, metadata]) {
    let condition
    const response = await download(
      "GET",
      {},
      {
        DOWNLOADS: {
          head: async () => metadata,
          get: async (_name, options) => {
            condition = options.onlyIf
            return object
          },
        },
      }
    )
    assertUnavailable(response)
    assert.deepEqual(condition, { etagMatches: metadata.etag })
  }
})

test("unsupported architectures and methods cannot reach installer storage", async () => {
  const unreachable = {
    DOWNLOADS: {
      head: () => assert.fail("Invalid requests must not reach R2"),
      get: () => assert.fail("Invalid requests must not reach R2"),
    },
  }
  for (const architecture of [
    "invalid",
    "../../private",
    "ARM64",
    "arm64.dmg",
  ]) {
    const response = await download("GET", {}, unreachable, architecture)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: "Unknown download." })
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await download(method, {}, unreachable)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get("allow"), "GET, HEAD")
    assert.deepEqual(await response.json(), { error: "Method not allowed." })
    assert.equal(response.headers.get("set-cookie"), null)
  }
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
