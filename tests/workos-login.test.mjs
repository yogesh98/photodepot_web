import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { after, before, test } from "node:test"
import { sealData, unsealData } from "iron-session"
import {
  handleAdminLogin,
  handleAdminCallback,
  handleAdminLogout,
  authenticateLicenseAdmin,
} from "../lib/license-admin-auth.ts"

const origin = "https://photodepot.app"
const clientId = "client_flow_admin"
const organizationId = "org_flow_admin"
const password = "workos-flow-test-cookie-password-with-32-characters"
const env = {
  WORKOS_CLIENT_ID: clientId,
  WORKOS_ADMIN_ORGANIZATION_ID: organizationId,
  WORKOS_COOKIE_PASSWORD: password,
  WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
}
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "flow-key",
  alg: "RS256",
  use: "sig",
}
const user = {
  id: "user_flow_admin",
  email: "owner@example.com",
  email_verified: true,
  first_name: "Test",
  last_name: "Owner",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}
let originalFetch, expectedVerifier, calls, tokenClaims
function jwt(claims = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: user.id,
      sid: "session_flow_admin",
      org_id: organizationId,
      role: "owner",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}
before(() => {
  originalFetch = globalThis.fetch
  calls = []
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    calls.push(url)
    if (url === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    assert.equal(url, "https://api.workos.com/user_management/authenticate")
    const body = JSON.parse(options.body)
    assert.equal(body.client_id, clientId)
    assert.equal(body.grant_type, "authorization_code")
    assert.equal(body.code_verifier, expectedVerifier)
    assert.equal(body.code, "test-code")
    assert.equal("client_secret" in body, false)
    return Response.json({
      user,
      access_token: jwt(tokenClaims),
      refresh_token: "refresh-flow-token",
      authentication_method: "MagicAuth",
    })
  }
})
after(() => {
  globalThis.fetch = originalFetch
})
function request(path, cookie, method = "GET", requestOrigin = origin) {
  return new Request(`${requestOrigin}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { origin: requestOrigin } : {}),
    },
  })
}
async function begin() {
  const response = await handleAdminLogin(request("/api/auth/login"), env)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const authorization = new URL(response.headers.get("location"))
  assert.equal(authorization.origin, "https://api.workos.com")
  assert.equal(authorization.searchParams.get("client_id"), clientId)
  assert.equal(
    authorization.searchParams.get("organization_id"),
    organizationId
  )
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    env.WORKOS_REDIRECT_URI
  )
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256")
  const header = response.headers.get("set-cookie")
  assert.match(header, /^__Host-photodepot-login=/)
  assert.match(header, /HttpOnly/)
  assert.match(header, /Secure/)
  assert.match(header, /SameSite=Lax/)
  assert.doesNotMatch(header, /Domain=/)
  const cookie = header.split(";")[0]
  const transaction = await unsealData(cookie.slice(cookie.indexOf("=") + 1), {
    password,
    ttl: 600,
  })
  assert.equal(transaction.state, authorization.searchParams.get("state"))
  assert.equal(
    createHash("sha256").update(transaction.codeVerifier).digest("base64url"),
    authorization.searchParams.get("code_challenge")
  )
  expectedVerifier = transaction.codeVerifier
  return { cookie, transaction }
}
test("PKCE callback establishes encrypted Owner session without an API key", async () => {
  tokenClaims = {}
  const { cookie, transaction } = await begin()
  const response = await handleAdminCallback(
    request(
      `/api/auth/callback?code=test-code&state=${transaction.state}`,
      cookie
    ),
    env
  )
  assert.equal(response.status, 303)
  assert.equal(response.headers.get("location"), "/admin")
  const cookies = response.headers.getSetCookie()
  assert.ok(
    cookies.some(
      (value) =>
        value.startsWith("__Host-photodepot-login=;") &&
        value.includes("Max-Age=0")
    )
  )
  const sessionCookie = cookies.find((value) =>
    value.startsWith("__Host-photodepot-admin=")
  )
  assert.ok(sessionCookie.length < 4096)
  assert.doesNotMatch(sessionCookie, /refresh-flow-token|owner@example.com/)
  const auth = await authenticateLicenseAdmin(
    request("/api/admin/licenses", sessionCookie.split(";")[0]),
    env
  )
  assert.deepEqual(auth, {
    email: user.email,
    userId: user.id,
    sessionId: "session_flow_admin",
  })
  const logout = await handleAdminLogout(
    request("/api/auth/logout", sessionCookie.split(";")[0], "POST"),
    env
  )
  assert.equal(logout.status, 200)
  const html = await logout.text()
  assert.match(html, /http-equiv="refresh"/)
  const target = new URL(
    html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&")
  )
  assert.equal(target.origin, "https://api.workos.com")
  assert.equal(target.searchParams.get("session_id"), "session_flow_admin")
  assert.equal(target.searchParams.get("return_to"), `${origin}/`)
  assert.ok(
    logout.headers.getSetCookie().every((value) => value.includes("Max-Age=0"))
  )
})
test("callback rejects missing, forged, mismatched and expired login transactions before exchange", async () => {
  const { cookie, transaction } = await begin()
  const validUrl = `/api/auth/callback?code=test-code&state=${transaction.state}`
  const start = calls.length
  for (const [path, suppliedCookie] of [
    [validUrl, undefined],
    [validUrl, `${cookie.slice(0, 70)}x${cookie.slice(71)}`],
    ["/api/auth/callback?code=test-code&state=wrong", cookie],
    [
      `/api/auth/callback?error=access_denied&state=${transaction.state}`,
      cookie,
    ],
  ]) {
    assert.equal(
      (await handleAdminCallback(request(path, suppliedCookie), env)).status,
      401
    )
  }
  const now = Date.now
  let expired
  try {
    Date.now = () => now() - 1200_000
    expired = await sealData(transaction, { password, ttl: 600 })
  } finally {
    Date.now = now
  }
  assert.equal(
    (
      await handleAdminCallback(
        request(validUrl, `__Host-photodepot-login=${expired}`),
        env
      )
    ).status,
    401
  )
  assert.equal(calls.length, start)
})
test("callback cannot create a session for a non-Owner or another organization", async () => {
  for (const claims of [{ role: "member" }, { org_id: "org_elsewhere" }]) {
    tokenClaims = claims
    const { cookie, transaction } = await begin()
    const response = await handleAdminCallback(
      request(
        `/api/auth/callback?code=test-code&state=${transaction.state}`,
        cookie
      ),
      env
    )
    assert.equal(response.status, 403)
    assert.ok(
      response.headers
        .getSetCookie()
        .every(
          (value) =>
            !value.startsWith("__Host-photodepot-admin=") ||
            value.includes("Max-Age=0")
        )
    )
  }
})
test("auth routes restrict methods, logout origin and production hostnames", async () => {
  assert.equal(
    (await handleAdminLogin(request("/api/auth/login", undefined, "POST"), env))
      .status,
    405
  )
  assert.equal(
    (
      await handleAdminCallback(
        request("/api/auth/callback", undefined, "POST"),
        env
      )
    ).status,
    405
  )
  assert.equal(
    (await handleAdminLogout(request("/api/auth/logout"), env)).status,
    405
  )
  for (const originHeader of [undefined, "null", "https://attacker.example"]) {
    assert.equal(
      (
        await handleAdminLogout(
          new Request(`${origin}/api/auth/logout`, {
            method: "POST",
            headers: {
              referer: `${origin}/admin/subscriptions`,
              ...(originHeader ? { origin: originHeader } : {}),
            },
          }),
          env
        )
      ).status,
      403
    )
  }
  assert.equal(
    (
      await handleAdminLogin(
        request(
          "/api/auth/login",
          undefined,
          "GET",
          "https://preview.photodepot-web.pages.dev"
        ),
        env
      )
    ).status,
    403
  )
  assert.equal(
    (
      await handleAdminLogin(request("/api/auth/login"), {
        ...env,
        WORKOS_COOKIE_PASSWORD: "short",
      })
    ).status,
    503
  )
})
test("sign-out ends the hosted WorkOS session even after its access token expires", async () => {
  const value = await sealData(
    {
      version: 1,
      clientId,
      origin,
      accessToken: jwt({ exp: 1 }),
      refreshToken: "refresh-flow-token",
      user: { id: user.id, email: user.email, emailVerified: true },
    },
    { password, ttl: 604800 }
  )
  const start = calls.length
  const response = await handleAdminLogout(
    request("/api/auth/logout", `__Host-photodepot-admin=${value}`, "POST"),
    env
  )
  const html = await response.text()
  assert.equal(
    new URL(
      html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&")
    ).searchParams.get("session_id"),
    "session_flow_admin"
  )
  assert.equal(calls.length, start)
  assert.ok(
    response.headers
      .getSetCookie()
      .every((cookie) => cookie.includes("Max-Age=0"))
  )
})
