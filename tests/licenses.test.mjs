import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { sealData, unsealData } from "iron-session"
import { handleAdminLicenses } from "../functions/api/admin/licenses.ts"
import { handleLicenseRequest } from "../lib/license-api.ts"
import { authenticateLicenseAdmin } from "../lib/license-admin-auth.ts"
import { allowLicenseAttempt } from "../lib/license-rate-limit.ts"

const vendor = generateKeyPairSync("ed25519")
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const issuer = "https://api.workos.com"
const origin = "https://photodepot.app"
const clientId = "client_test_admin"
const organizationId = "org_test_admin"
const cookiePassword = "license-test-cookie-password-at-least-32-characters"
const adminEmail = "yogesh.patel0221@gmail.com"
const userId = "user_test_admin"
const sessionId = "session_test_admin"
const jwksUrl = `${issuer}/sso/jwks/${clientId}`
let refreshResponse
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
    WORKOS_CLIENT_ID: clientId,
    WORKOS_ADMIN_ORGANIZATION_ID: organizationId,
    WORKOS_COOKIE_PASSWORD: cookiePassword,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
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
  globalThis.fetch = async (url, options) => {
    if (String(url) === `${issuer}/user_management/authenticate`) {
      assert.equal(options.method, "POST")
      const body = JSON.parse(options.body)
      assert.equal(body.client_id, clientId)
      assert.equal(body.grant_type, "refresh_token")
      assert.equal(body.organization_id, organizationId)
      assert.equal("client_secret" in body, false)
      return refreshResponse
        ? Response.json(refreshResponse)
        : Response.json({ error: "invalid_grant" }, { status: 400 })
    }
    assert.equal(String(url), jwksUrl)
    assert.equal(options?.redirect, "manual")
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
      client_id: clientId,
      org_id: organizationId,
      role: "owner",
      sub: userId,
      sid: sessionId,
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
async function sessionCookie(
  token = jwt(),
  changes = {},
  password = cookiePassword
) {
  const sealed = await sealData(
    {
      version: 1,
      clientId,
      origin,
      accessToken: token,
      refreshToken: "test-refresh-token",
      user: { id: userId, email: adminEmail, emailVerified: true },
      ...changes,
    },
    { password, ttl: 604800 }
  )
  return `__Host-photodepot-admin=${sealed}`
}
async function admin(body, headers = {}, method, hostname) {
  return handleAdminLicenses(
    request(
      "/api/admin/licenses",
      body,
      { cookie: await sessionCookie(), ...headers },
      method,
      hostname
    ),
    env
  )
}

test("WorkOS rejects absent, forged and invalid sessions without trusting legacy Access headers", async () => {
  const unauthorizedCookies = [
    undefined,
    "__Host-photodepot-admin=forged",
    await sessionCookie(
      jwt(),
      {},
      "wrong-cookie-password-at-least-32-characters"
    ),
    await sessionCookie("forged"),
    await sessionCookie(jwt({ exp: 1 })),
    await sessionCookie(jwt({ iss: "https://attacker.example" })),
    await sessionCookie(jwt({ client_id: "client_other" })),
    await sessionCookie(jwt({ sub: "user_other" })),
    await sessionCookie(jwt({ sid: undefined })),
    await sessionCookie(jwt({ iat: Date.now() / 1000 + 120 })),
    await sessionCookie(jwt({ nbf: Date.now() / 1000 + 120 })),
    await sessionCookie(jwt({}, { alg: "none" })),
    await sessionCookie(jwt({}, { alg: "HS256" })),
    await sessionCookie(`${jwt().slice(0, -8)}tampered`),
    await sessionCookie(jwt(), { clientId: "client_other" }),
    await sessionCookie(jwt(), { origin: "https://attacker.example" }),
    await sessionCookie(jwt(), { version: 2 }),
  ]
  for (const cookie of unauthorizedCookies) {
    const response = await authenticateLicenseAdmin(
      request("/admin/licenses", undefined, {
        ...(cookie ? { cookie } : {}),
        "cf-access-jwt-assertion": jwt(),
        "cf-access-authenticated-user-email": adminEmail,
      }),
      env
    )
    assert.ok(response instanceof Response)
    assert.equal(response.status, 401)
  }
  const sealed = await sessionCookie()
  assert.deepEqual(
    await authenticateLicenseAdmin(
      request("/admin/licenses", undefined, { cookie: sealed }),
      env
    ),
    { email: adminEmail, userId, sessionId }
  )
  for (const missing of [
    "WORKOS_CLIENT_ID",
    "WORKOS_ADMIN_ORGANIZATION_ID",
    "WORKOS_COOKIE_PASSWORD",
    "WORKOS_REDIRECT_URI",
  ]) {
    assert.equal(
      (
        await authenticateLicenseAdmin(request("/admin/licenses"), {
          ...env,
          [missing]: "",
        })
      ).status,
      503
    )
  }
})

test("WorkOS authorization requires Owner in the configured organization and supports multiple roles", async () => {
  for (const claims of [
    { role: "member" },
    { role: "owner", org_id: "org_other" },
    { role: "Owner" },
    { role: "member", roles: ["member", "org-owner"] },
  ]) {
    const response = await authenticateLicenseAdmin(
      request("/admin/licenses", undefined, {
        cookie: await sessionCookie(jwt(claims)),
      }),
      env
    )
    assert.equal(response.status, 403)
  }
  assert.deepEqual(
    await authenticateLicenseAdmin(
      request("/admin/licenses", undefined, {
        cookie: await sessionCookie(
          jwt({ role: "member", roles: ["member", "owner"] })
        ),
      }),
      env
    ),
    { email: adminEmail, userId, sessionId }
  )
  const otherEmail = "another-owner@example.com"
  assert.deepEqual(
    await authenticateLicenseAdmin(
      request("/admin/licenses", undefined, {
        cookie: await sessionCookie(jwt(), {
          user: { id: userId, email: otherEmail, emailVerified: true },
        }),
      }),
      env
    ),
    { email: otherEmail, userId, sessionId }
  )
})

test("expired WorkOS sessions refresh with public-client credentials and rotate the sealed cookie", async () => {
  refreshResponse = {
    access_token: jwt(),
    refresh_token: "rotated-refresh-token",
    organization_id: organizationId,
    user: {
      object: "user",
      id: userId,
      email: adminEmail,
      email_verified: true,
    },
  }
  try {
    const auth = await authenticateLicenseAdmin(
      request("/api/admin/licenses", undefined, {
        cookie: await sessionCookie(jwt({ exp: 1 })),
      }),
      env
    )
    assert.equal(auth.email, adminEmail)
    assert.equal(auth.userId, userId)
    assert.equal(auth.sessionId, sessionId)
    assert.match(auth.setCookie, /^__Host-photodepot-admin=/)
    assert.match(auth.setCookie, /HttpOnly/i)
    assert.match(auth.setCookie, /Secure/i)
    const value = auth.setCookie
      .split(";")[0]
      .slice("__Host-photodepot-admin=".length)
    const session = await unsealData(value, {
      password: cookiePassword,
      ttl: 604800,
    })
    assert.equal(session.refreshToken, "rotated-refresh-token")
    assert.equal(session.accessToken, refreshResponse.access_token)
  } finally {
    refreshResponse = undefined
  }
})

test("WorkOS key-service outages fail closed without treating the user as signed out", async () => {
  const outageClient = "client_test_outage"
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `${issuer}/sso/jwks/${outageClient}`)
    assert.equal(options.redirect, "manual")
    return new Response(null, { status: 503 })
  }
  try {
    const response = await authenticateLicenseAdmin(
      request("/api/admin/licenses", undefined, {
        cookie: await sessionCookie(jwt({ client_id: outageClient }), {
          clientId: outageClient,
        }),
      }),
      { ...env, WORKOS_CLIENT_ID: outageClient }
    )
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("set-cookie"), null)
  } finally {
    globalThis.fetch = previousFetch
  }
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

test("legacy key administration is read-only and masks stored hashes while keeping history", async () => {
  const id = "00000000-0000-4000-8000-000000000099"
  await env.DB.prepare(
    `INSERT INTO licenses(id,key_hash,key_suffix,type,customer_name,email,notes,created_at,updated_at) VALUES(?,'private-key-hash','ABCD','regular','Existing customer','existing@example.test','History',1,1)`
  )
    .bind(id)
    .run()
  await env.DB.prepare(
    `INSERT INTO license_audit(id,license_id,action,actor,created_at,detail) VALUES('legacy-audit',?,'grant','owner',1,'Existing grant')`
  )
    .bind(id)
    .run()
  const listing = await admin()
  assert.equal(listing.status, 200)
  const content = await listing.text()
  assert.equal(content.includes("private-key-hash"), false)
  assert.equal(JSON.parse(content).licenses[0].keySuffix, "ABCD")
  for (const action of ["grant", "revoke", "restore", "reset-device"]) {
    const response = await admin({ action, id })
    assert.equal(response.status, 410)
    assert.equal((await response.json()).code, "update_required")
  }
  for (const action of ["activate", "verify"]) {
    const response = await handleLicenseRequest(
      request(`/api/licenses/${action}`, {}),
      env,
      action
    )
    assert.equal(response.status, 410)
  }
  assert.equal(
    (
      await env.DB.prepare("SELECT status FROM licenses WHERE id=?")
        .bind(id)
        .first()
    ).status,
    "active"
  )
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) AS count FROM license_audit WHERE license_id=?"
      )
        .bind(id)
        .first()
    ).count,
    1
  )
})
