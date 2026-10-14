import assert from "node:assert/strict"
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAdminLicenses } from "../functions/api/admin/licenses.ts"
import { handleLicenseRequest } from "../lib/license-api.ts"
import {
  authenticateLicenseAdmin,
  LICENSE_ADMIN_EMAIL,
} from "../lib/license-admin-auth.ts"
import { allowLicenseAttempt } from "../lib/license-rate-limit.ts"
import { LICENSE_GRACE_MS } from "../lib/license-crypto.ts"

const vendor = generateKeyPairSync("ed25519")
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const issuer = "https://license-test.cloudflareaccess.com"
const origin = "https://photodepot.app"
const audience = "test-license-admin-audience"
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "test-rsa-key",
  alg: "RS256",
  use: "sig",
}
let platform, env, originalFetch
let sequence = 0
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = {
    ...platform.env,
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    PHOTODEPOT_ACCESS_ISSUER: issuer,
    PHOTODEPOT_ACCESS_AUDIENCE: audience,
  }
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
  originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`)
    return Response.json({ keys: [jwk] })
  }
})
after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})
function jwt(changes = {}, headerChanges = {}, key = rsa.privateKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid, ...headerChanges })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: [audience],
      email: LICENSE_ADMIN_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      ...changes,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`
}
function request(
  path,
  body,
  headers = {},
  method = body ? "POST" : "GET",
  hostname = origin
) {
  return new Request(`${hostname}${path}`, {
    method,
    headers: {
      origin: hostname,
      "content-type": "application/json",
      "cf-connecting-ip": `test-${sequence++}`,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
function admin(body, headers = {}, method, hostname) {
  return handleAdminLicenses(
    request(
      "/api/admin/licenses",
      body,
      { "cf-access-jwt-assertion": jwt(), ...headers },
      method,
      hostname
    ),
    env
  )
}
async function grant(type = "trial") {
  const response = await admin({
    action: "grant",
    type,
    customerName: "Alex Photographer",
    email: " Alex@Example.com ",
    notes: "Customer note <script>example</script>",
  })
  assert.equal(response.status, 201)
  return response.json()
}
function device() {
  const pair = generateKeyPairSync("ed25519")
  const bytes = pair.publicKey.export({ format: "der", type: "spki" })
  return {
    ...pair,
    publicKeyEncoded: bytes.toString("base64url"),
    id: createHash("sha256").update(bytes).digest("hex"),
  }
}
function activation(key, mac) {
  const challenge = randomBytes(32).toString("base64url")
  const normalized = key.trim().toUpperCase()
  return {
    key,
    devicePublicKey: mac.publicKeyEncoded,
    challenge,
    signature: sign(
      null,
      Buffer.from(
        JSON.stringify([
          "photodepot-license-v1",
          "activate",
          normalized,
          mac.publicKeyEncoded,
          challenge,
        ])
      ),
      mac.privateKey
    ).toString("base64url"),
  }
}
function verification(mac) {
  const challenge = randomBytes(32).toString("base64url")
  return {
    deviceId: mac.id,
    challenge,
    signature: sign(
      null,
      Buffer.from(
        JSON.stringify(["photodepot-license-v1", "verify", mac.id, challenge])
      ),
      mac.privateKey
    ).toString("base64url"),
  }
}
function activate(key, mac, bindings = env) {
  return handleLicenseRequest(
    request("/api/licenses/activate", activation(key, mac)),
    bindings,
    "activate"
  )
}
function check(mac, bindings = env) {
  return handleLicenseRequest(
    request("/api/licenses/verify", verification(mac)),
    bindings,
    "verify"
  )
}
async function receipt(response) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const envelope = await response.json()
  const bytes = Buffer.from(envelope.payload, "base64url")
  assert.ok(
    verify(
      null,
      bytes,
      vendor.publicKey,
      Buffer.from(envelope.signature, "base64url")
    )
  )
  const payload = JSON.parse(bytes.toString())
  assert.equal(payload.version, 1)
  assert.equal(payload.expiresAt - payload.issuedAt, LICENSE_GRACE_MS)
  assert.ok(Math.abs(payload.issuedAt - Date.now()) < 10_000)
  assert.equal("email" in payload, false)
  assert.equal("key" in payload, false)
  return payload
}

test("Cloudflare Access rejects absent, forged, expired, wrong audience/issuer/email and unsafe algorithms", async () => {
  for (const token of [
    undefined,
    "forged",
    jwt({ exp: 1 }),
    jwt({ iss: "https://other.cloudflareaccess.com" }),
    jwt({ aud: ["other"] }),
    jwt({ email: "attacker@example.com" }),
    jwt({ iat: Date.now() / 1000 + 120 }),
    jwt({ nbf: Date.now() / 1000 + 120 }),
    jwt({}, { alg: "none" }),
    jwt({}, { alg: "HS256" }),
    `${jwt().slice(0, -8)}tampered`,
  ]) {
    const response = await authenticateLicenseAdmin(
      request("/admin/licenses", undefined, {
        ...(token ? { "cf-access-jwt-assertion": token } : {}),
        "cf-access-authenticated-user-email": LICENSE_ADMIN_EMAIL,
      }),
      env
    )
    assert.ok(response instanceof Response)
    assert.equal(response.status, 401)
  }
  assert.deepEqual(
    await authenticateLicenseAdmin(
      request("/admin/licenses", undefined, {
        "cf-access-jwt-assertion": jwt(),
      }),
      env
    ),
    { email: LICENSE_ADMIN_EMAIL }
  )
  assert.equal(
    (
      await authenticateLicenseAdmin(request("/admin/licenses"), {
        ...env,
        PHOTODEPOT_ACCESS_AUDIENCE: "",
      })
    ).status,
    503
  )
  assert.equal(
    (
      await handleAdminLicenses(
        request(
          "/api/admin/licenses",
          undefined,
          {},
          "GET",
          "https://preview.photodepot-web.pages.dev"
        ),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (await admin({ action: "grant" }, { origin: "https://attacker.example" }))
      .status,
    403
  )
})

test("grant returns a high-entropy key once; list masks keys, normalizes email and records an audit", async () => {
  const granted = await grant()
  assert.match(granted.key, /^PD-(?:[A-F0-9]{8}-){5}[A-F0-9]{8}$/)
  const stored = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?")
    .bind(granted.license.id)
    .first()
  assert.equal(
    stored.key_hash,
    createHash("sha256").update(granted.key).digest("hex")
  )
  assert.equal(stored.key_suffix, granted.key.slice(-4))
  assert.equal(stored.email, "alex@example.com")
  const response = await admin()
  assert.equal(response.status, 200)
  const serialized = await response.text()
  assert.ok(!serialized.includes(granted.key))
  assert.ok(!serialized.includes(stored.key_hash))
  const audit = await handleAdminLicenses(
    request(`/api/admin/licenses?id=${granted.license.id}`, undefined, {
      "cf-access-jwt-assertion": jwt(),
    }),
    env
  )
  assert.equal((await audit.json()).audit[0].action, "grant")
})

test("activation proof binds one Mac atomically under concurrent first activation and echoes challenge", async () => {
  const { key } = await grant()
  const macs = Array.from({ length: 6 }, device)
  const responses = await Promise.all(
    macs.map((mac) => activate(`  ${key.toLowerCase()}  `, mac))
  )
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    1
  )
  assert.equal(
    responses.filter((response) => response.status === 409).length,
    5
  )
  const mac = macs[responses.findIndex((response) => response.status === 200)]
  const body = verification(mac)
  const payload = await receipt(
    await handleLicenseRequest(
      request("/api/licenses/verify", body),
      env,
      "verify"
    )
  )
  assert.equal(payload.deviceId, mac.id)
  assert.equal(payload.challenge, body.challenge)
  assert.equal(payload.status, "active")
  assert.equal(payload.type, "trial")
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) AS count FROM license_devices WHERE device_id = ?"
      )
        .bind(mac.id)
        .first()
    ).count,
    1
  )
  assert.equal((await activate(key, mac)).status, 200)
})

test("both license types revoke immediately on the server and restore with signed receipts; type changes preserve assignment", async () => {
  for (const type of ["trial", "regular"]) {
    const { key, license } = await grant(type)
    const mac = device()
    const active = await receipt(await activate(key, mac))
    const response = await admin({ action: "revoke", id: license.id })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.license.status, "revoked")
    assert.equal(result.license.deviceId, mac.id)
    // The desktop keeps an admitted session until quit; the server must still
    // return the latest revocation and reject activation by either Mac.
    const revoked = await receipt(await check(mac))
    assert.equal(revoked.status, "revoked")
    assert.equal(revoked.type, type)
    assert.ok(revoked.revision > active.revision)
    assert.equal((await activate(key, mac)).status, 409)
    assert.equal((await activate(key, device())).status, 409)
    assert.equal(
      (await admin({ action: "restore", id: license.id })).status,
      200
    )
    const restored = await receipt(await check(mac))
    assert.equal(restored.status, "active")
    assert.ok(restored.revision > revoked.revision)
    const other = type === "trial" ? "regular" : "trial"
    assert.equal(
      (await admin({ action: "set-type", id: license.id, type: other })).status,
      200
    )
    const changed = await receipt(await check(mac))
    assert.equal(changed.type, other)
    assert.equal(changed.status, "active")
    assert.equal(changed.deviceId, mac.id)
  }
})

test("reset invalidates old device even after restoration and permits exactly one replacement", async () => {
  const { key, license } = await grant()
  const old = device()
  await receipt(await activate(key, old))
  assert.equal(
    (await admin({ action: "reset-device", id: license.id })).status,
    200
  )
  assert.equal((await receipt(await check(old))).status, "revoked")
  const replacement = device()
  assert.equal(
    (await receipt(await activate(key, replacement))).status,
    "active"
  )
  assert.equal((await receipt(await check(old))).status, "revoked")
  assert.equal((await activate(key, old)).status, 409)
  await admin({ action: "revoke", id: license.id })
  await admin({ action: "restore", id: license.id })
  assert.equal((await receipt(await check(old))).status, "revoked")
  assert.equal((await receipt(await check(replacement))).status, "active")
})

test("a Mac cannot consume a different license until its current assignment is reset", async () => {
  const first = await grant()
  const second = await grant()
  const mac = device()
  await receipt(await activate(first.key, mac))
  assert.equal((await activate(second.key, mac)).status, 409)
  await admin({ action: "reset-device", id: first.license.id })
  const moved = await receipt(await activate(second.key, mac))
  assert.equal(moved.licenseId, second.license.id)
  assert.equal((await receipt(await check(mac))).licenseId, second.license.id)
})

test("invalid proofs, unknown devices, malformed bodies and service outages never issue authorization", async () => {
  const { key } = await grant()
  const mac = device()
  const forged = activation(key, mac)
  forged.signature = sign(
    null,
    Buffer.from("wrong proof"),
    device().privateKey
  ).toString("base64url")
  assert.equal(
    (
      await handleLicenseRequest(
        request("/api/licenses/activate", forged),
        env,
        "activate"
      )
    ).status,
    401
  )
  assert.equal((await check(mac)).status, 404)
  assert.equal(
    (
      await activate(key, mac, {
        ...env,
        PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: "",
      })
    ).status,
    503
  )
  assert.equal(
    (await activate(key, mac, { ...env, DB: undefined })).status,
    503
  )
  await receipt(await activate(key, mac))
  const body = verification(mac)
  body.signature = verification(device()).signature
  assert.equal(
    (
      await handleLicenseRequest(
        request("/api/licenses/verify", body),
        env,
        "verify"
      )
    ).status,
    401
  )
  assert.equal(
    (await handleLicenseRequest(request("/api/licenses/verify"), env, "verify"))
      .status,
    405
  )
  assert.equal(
    (
      await handleLicenseRequest(
        request("/api/licenses/verify", {}, { "content-type": "text/plain" }),
        env,
        "verify"
      )
    ).status,
    415
  )
  assert.equal(
    (
      await handleLicenseRequest(
        request("/api/licenses/verify", { challenge: "x".repeat(9000) }),
        env,
        "verify"
      )
    ).status,
    413
  )
  assert.equal(
    (
      await handleLicenseRequest(
        new Request(`${origin}/api/licenses/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        env,
        "verify"
      )
    ).status,
    400
  )
  assert.equal(
    (
      await handleLicenseRequest(
        request("/api/licenses/verify", { challenge: "short" }),
        env,
        "verify"
      )
    ).status,
    400
  )
})

test("shared rate limiter caps concurrent attempts, expires counters and stores no raw IP", async () => {
  const ip = "198.51.100.29"
  const now = 1_800_000_000_000
  const attempts = await Promise.all(
    Array.from({ length: 20 }, () =>
      allowLicenseAttempt(
        env.DB,
        "limiter-test",
        ip,
        "test-secret",
        12,
        600_000,
        now
      )
    )
  )
  assert.equal(attempts.filter(Boolean).length, 12)
  assert.equal(
    await allowLicenseAttempt(
      env.DB,
      "limiter-test",
      ip,
      "test-secret",
      12,
      600_000,
      now + 599_999
    ),
    false
  )
  assert.equal(
    await allowLicenseAttempt(
      env.DB,
      "limiter-test",
      ip,
      "test-secret",
      12,
      600_000,
      now + 600_000
    ),
    true
  )
  const rows = await env.DB.prepare("SELECT key FROM license_attempts").all()
  assert.ok(
    rows.results.every(
      ({ key }) => /^[a-f0-9]{64}$/.test(key) && !key.includes(ip)
    )
  )
})

test("admin validates edits and cursor without changing license records on invalid requests", async () => {
  assert.equal(
    (
      await admin({
        action: "grant",
        type: "trial",
        customerName: "",
        email: "bad",
        notes: "",
      })
    ).status,
    400
  )
  assert.equal((await admin({ action: "grant", type: "invalid" })).status, 400)
  assert.equal(
    (await admin({ action: "set-type", id: "bad", type: "regular" })).status,
    400
  )
  assert.equal(
    (
      await admin({
        action: "revoke",
        id: "00000000-0000-0000-0000-000000000000",
      })
    ).status,
    404
  )
  assert.equal((await admin(undefined, {}, "DELETE")).status, 405)
  assert.equal(
    (
      await handleAdminLicenses(
        request("/api/admin/licenses?cursor=garbage", undefined, {
          "cf-access-jwt-assertion": jwt(),
        }),
        env
      )
    ).status,
    400
  )
})

test("a revoked trial can be replaced by a regular key without old restoration stealing its Mac", async () => {
  const trial = await grant("trial")
  const regular = await grant("regular")
  const mac = device()
  await receipt(await activate(trial.key, mac))
  await admin({ action: "revoke", id: trial.license.id })
  const replaced = await receipt(await activate(regular.key, mac))
  assert.equal(replaced.type, "regular")
  assert.equal(replaced.licenseId, regular.license.id)
  const previous = await env.DB.prepare(
    "SELECT current_device_id, status FROM licenses WHERE id = ?"
  )
    .bind(trial.license.id)
    .first()
  assert.equal(previous.current_device_id, null)
  assert.equal(previous.status, "revoked")
  await admin({ action: "restore", id: trial.license.id })
  assert.equal((await receipt(await check(mac))).licenseId, regular.license.id)
  assert.equal((await activate(trial.key, mac)).status, 409)
  const audit = await env.DB.prepare(
    "SELECT count(*) AS count FROM license_audit WHERE license_id = ? AND action = 'replace-revoked-device'"
  )
    .bind(trial.license.id)
    .first()
  assert.equal(audit.count, 1)
})
