import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { after, before, beforeEach, test } from "node:test"
import { readFile, readdir } from "node:fs/promises"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { sealData, unsealData } from "iron-session"
import {
  authenticateLicenseAdmin,
  authenticateWorkOSAccount,
  handleAccountLogin,
  handleAccountLogout,
  handleAdminCallback,
  handleAdminLogin,
} from "../lib/license-admin-auth.ts"
import { onRequest as loginRoute } from "../functions/api/account/auth/login.ts"
import { onRequest as logoutRoute } from "../functions/api/account/auth/logout.ts"
import { onRequest as accountMiddleware } from "../functions/_middleware.ts"
import { handleAdminReminders } from "../functions/api/admin/subscription-reminders.ts"
import {
  getSubscription,
  listSubscriptionAudit,
  changeSubscription,
  setSubscription,
} from "../lib/subscription-store.ts"

const origin = "https://photodepot.app"
const clientId = "client_account_flow"
const organizationId = "org_account_admin"
const password = "account-flow-test-cookie-secret-at-least-32-characters"
const pairingCode = "A".repeat(43)
const activationPath = `/account/activate?code=${pairingCode}`
const env = {
  WORKOS_CLIENT_ID: clientId,
  WORKOS_ADMIN_ORGANIZATION_ID: organizationId,
  WORKOS_COOKIE_PASSWORD: password,
  WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
}
const user = {
  id: "user_account_customer",
  email: "customer@example.test",
  email_verified: true,
  first_name: "Test",
  last_name: "Customer",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "account-flow-key",
  alg: "RS256",
  use: "sig",
}
let originalFetch,
  platform,
  expectedVerifier,
  exchanges,
  tokenClaims,
  returnedUser,
  failRefresh
function jwt(claims = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: user.id,
      sid: "session_account_customer",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env.DB = platform.env.DB
  for (const filename of (
    await readdir(new URL("../migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8"
    )
    await env.DB.batch(
      unstable_splitSqlQuery(sql).map((statement) => env.DB.prepare(statement))
    )
  }
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    if (url === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    assert.equal(url, "https://api.workos.com/user_management/authenticate")
    const body = JSON.parse(options.body)
    exchanges.push(body)
    assert.equal(body.client_id, clientId)
    assert.equal("client_secret" in body, false)
    if (body.grant_type === "authorization_code") {
      assert.equal(body.code_verifier, expectedVerifier)
      assert.equal(body.code, "test-account-code")
    } else {
      assert.equal(body.grant_type, "refresh_token")
      assert.equal(body.refresh_token, "refresh-account-token")
      assert.equal("organization_id" in body, false)
      if (failRefresh) return new Response(null, { status: failRefresh })
    }
    return Response.json({
      user: returnedUser,
      access_token: jwt(tokenClaims),
      refresh_token: "refresh-account-rotated",
      authentication_method: "MagicAuth",
    })
  }
})
beforeEach(async () => {
  await env.DB.batch(
    ["DELETE FROM subscription_audit", "DELETE FROM subscriptions"].map((sql) =>
      env.DB.prepare(sql)
    )
  )
  expectedVerifier = undefined
  exchanges = []
  tokenClaims = {}
  returnedUser = { ...user }
  failRefresh = undefined
})
after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
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
function cookiePair(header) {
  return header.split(";")[0]
}
function cookieValue(pair) {
  return pair.slice(pair.indexOf("=") + 1)
}
function responseCookie(response, name) {
  return response.headers
    .getSetCookie()
    .find(
      (value) => value.startsWith(`${name}=`) && !value.includes("Max-Age=0")
    )
}
async function beginAccount() {
  const response = await handleAccountLogin(
    request(`/api/account/auth/login?code=${pairingCode}`),
    env
  )
  assert.equal(response.status, 302)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.equal(response.headers.get("referrer-policy"), "no-referrer")
  const authorization = new URL(response.headers.get("location"))
  assert.equal(authorization.origin, "https://api.workos.com")
  assert.equal(authorization.searchParams.get("client_id"), clientId)
  assert.equal(authorization.searchParams.has("organization_id"), false)
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256")
  const header = responseCookie(response, "__Host-photodepot-account-login")
  assert.ok(header)
  assert.match(header, /HttpOnly/)
  assert.match(header, /Secure/)
  assert.match(header, /SameSite=Lax/)
  assert.doesNotMatch(header, /Domain=/)
  const cookie = cookiePair(header)
  const transaction = await unsealData(cookieValue(cookie), {
    password,
    ttl: 600,
  })
  assert.equal(transaction.audience, "account")
  assert.equal(transaction.returnPath, activationPath)
  assert.equal(transaction.state, authorization.searchParams.get("state"))
  assert.equal(
    createHash("sha256").update(transaction.codeVerifier).digest("base64url"),
    authorization.searchParams.get("code_challenge")
  )
  expectedVerifier = transaction.codeVerifier
  return { cookie, transaction }
}
async function callback(cookie, state) {
  return handleAdminCallback(
    request(`/api/auth/callback?code=test-account-code&state=${state}`, cookie),
    env
  )
}
async function sessionCookie(
  audience = "account",
  claims = {},
  overrides = {}
) {
  const value = await sealData(
    {
      version: 1,
      audience,
      clientId,
      origin,
      accessToken: jwt(claims),
      refreshToken: "refresh-account-token",
      user: { id: user.id, email: user.email, emailVerified: true },
      ...overrides,
    },
    { password, ttl: 604800 }
  )
  return `__Host-photodepot-${audience}=${value}`
}

test("verified customer without an organization gets only an encrypted account session", async () => {
  const { cookie, transaction } = await beginAccount()
  const response = await callback(cookie, transaction.state)
  assert.equal(response.status, 303)
  assert.equal(response.headers.get("location"), activationPath)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const session = responseCookie(response, "__Host-photodepot-account")
  assert.ok(session.length < 4096)
  assert.match(session, /HttpOnly/)
  assert.match(session, /Secure/)
  assert.match(session, /SameSite=Lax/)
  assert.doesNotMatch(
    session,
    /Domain=|refresh-account-rotated|customer@example/
  )
  assert.equal(responseCookie(response, "__Host-photodepot-admin"), undefined)
  assert.ok(
    response.headers
      .getSetCookie()
      .some(
        (value) =>
          value.startsWith("__Host-photodepot-account-login=;") &&
          value.includes("Max-Age=0")
      )
  )
  const sealed = await unsealData(cookieValue(cookiePair(session)), {
    password,
    ttl: 604800,
  })
  assert.equal(sealed.audience, "account")
  const auth = await authenticateWorkOSAccount(
    request("/api/account/device", cookiePair(session)),
    env
  )
  assert.deepEqual(auth, {
    email: user.email,
    userId: user.id,
    sessionId: "session_account_customer",
  })
  assert.equal(
    (
      await authenticateLicenseAdmin(
        request("/api/admin/subscriptions", cookiePair(session)),
        env
      )
    ).status,
    401
  )
})
test("account sign-in also permits a verified Member but never creates an admin session", async () => {
  tokenClaims = { org_id: organizationId, role: "member" }
  const { cookie, transaction } = await beginAccount()
  const response = await callback(cookie, transaction.state)
  assert.equal(response.status, 303)
  assert.equal(responseCookie(response, "__Host-photodepot-admin"), undefined)
  const accountCookie = responseCookie(response, "__Host-photodepot-account")
  assert.ok(accountCookie)
  assert.equal(
    (
      await authenticateLicenseAdmin(
        request("/api/admin/subscriptions", cookiePair(accountCookie)),
        env
      )
    ).status,
    401
  )
})
test("direct customer portal login uses its own session and a fixed safe return path", async () => {
  const response = await handleAccountLogin(
    request("/api/account/auth/login?next=https://attacker.example"),
    env
  )
  assert.equal(response.status, 302)
  const url = new URL(response.headers.get("location"))
  assert.equal(url.searchParams.has("organization_id"), false)
  const cookie = cookiePair(
    responseCookie(response, "__Host-photodepot-account-login")
  )
  const transaction = await unsealData(cookieValue(cookie), {
    password,
    ttl: 600,
  })
  assert.equal(transaction.returnPath, "/account")
  expectedVerifier = transaction.codeVerifier
  const done = await callback(cookie, transaction.state)
  assert.equal(done.status, 303)
  assert.equal(done.headers.get("location"), "/account")
  assert.ok(responseCookie(done, "__Host-photodepot-account"))
  assert.equal(responseCookie(done, "__Host-photodepot-admin"), undefined)
})
test("desktop signup opens the signup screen while retaining the exact Mac approval destination", async () => {
  const response = await handleAccountLogin(
    request(`/api/account/auth/login?code=${"a".repeat(43)}&intent=signup`),
    env
  )
  assert.equal(response.status, 302)
  const authorization = new URL(response.headers.get("location"))
  assert.equal(authorization.searchParams.get("screen_hint"), "sign-up")
  const cookie = cookiePair(
    responseCookie(response, "__Host-photodepot-account-login")
  )
  const transaction = await unsealData(cookieValue(cookie), {
    password,
    ttl: 600,
  })
  assert.equal(
    transaction.returnPath,
    `/account/activate?code=${"a".repeat(43)}`
  )
})
test("customer sign-in and callback do not depend on administration organization configuration", async () => {
  for (const organization of [undefined, "invalid"]) {
    const accountEnv = { ...env, WORKOS_ADMIN_ORGANIZATION_ID: organization }
    const login = await handleAccountLogin(
      request("/api/account/auth/login"),
      accountEnv
    )
    assert.equal(login.status, 302)
    const cookie = cookiePair(
      responseCookie(login, "__Host-photodepot-account-login")
    )
    const transaction = await unsealData(cookieValue(cookie), {
      password,
      ttl: 600,
    })
    expectedVerifier = transaction.codeVerifier
    const done = await handleAdminCallback(
      request(
        `/api/auth/callback?code=test-account-code&state=${transaction.state}`,
        cookie
      ),
      accountEnv
    )
    assert.equal(done.status, 303)
    assert.equal(done.headers.get("location"), "/account")
    const session = cookiePair(
      responseCookie(done, "__Host-photodepot-account")
    )
    assert.equal(
      (
        await authenticateWorkOSAccount(
          request("/account", session),
          accountEnv
        )
      ).userId,
      user.id
    )
    assert.equal(
      (await handleAdminLogin(request("/api/auth/login"), accountEnv)).status,
      503
    )
    assert.equal(
      (
        await authenticateLicenseAdmin(
          request("/admin/subscriptions", session),
          accountEnv
        )
      ).status,
      503
    )
  }
})
test("hosted sign-in restart keeps an unexpired Mac destination with fresh state and PKCE", async () => {
  const previous = await beginAccount()
  const login = await handleAccountLogin(
    request("/api/account/auth/login", previous.cookie),
    env
  )
  assert.equal(login.status, 302)
  const cookie = cookiePair(
    responseCookie(login, "__Host-photodepot-account-login")
  )
  const transaction = await unsealData(cookieValue(cookie), {
    password,
    ttl: 600,
  })
  assert.equal(transaction.returnPath, activationPath)
  assert.notEqual(transaction.state, previous.transaction.state)
  assert.notEqual(transaction.codeVerifier, previous.transaction.codeVerifier)
  expectedVerifier = transaction.codeVerifier
  const done = await callback(cookie, transaction.state)
  assert.equal(done.status, 303)
  assert.equal(done.headers.get("location"), activationPath)
})
test("hosted restarts ignore invalid, expired, cross-audience and foreign transactions", async () => {
  const previous = await beginAccount()
  const originalNow = Date.now
  let expired
  try {
    Date.now = () => originalNow() - 1200_000
    expired = await sealData(previous.transaction, { password, ttl: 600 })
  } finally {
    Date.now = originalNow
  }
  const invalid = ["forged", expired]
  for (const changes of [
    { audience: "admin" },
    { clientId: "client_other" },
    { origin: "https://attacker.example" },
    { returnPath: "//attacker.example" },
    { returnPath: "/admin/subscriptions" },
  ])
    invalid.push(
      await sealData(
        { ...previous.transaction, ...changes },
        { password, ttl: 600 }
      )
    )
  for (const value of invalid) {
    const login = await handleAccountLogin(
      request(
        "/api/account/auth/login",
        `__Host-photodepot-account-login=${value}`
      ),
      env
    )
    assert.equal(login.status, 302)
    const cookie = cookiePair(
      responseCookie(login, "__Host-photodepot-account-login")
    )
    const transaction = await unsealData(cookieValue(cookie), {
      password,
      ttl: 600,
    })
    assert.equal(transaction.returnPath, "/account")
  }
})
test("missing account callback cookies recover through customer sign-in, never Owner sign-in", async () => {
  const response = await callback(undefined, "missing-transaction")
  assert.equal(response.status, 401)
  const html = await response.text()
  assert.match(html, /href="\/api\/account\/auth\/login"/)
  assert.doesNotMatch(html, /href="\/api\/auth\/login"|Owner/)
  assert.equal(response.headers.get("referrer-policy"), "no-referrer")
  assert.equal(exchanges.length, 0)
})
test("failed account callbacks retain the verified Mac pairing destination for retry", async () => {
  const { cookie, transaction } = await beginAccount()
  const response = await handleAdminCallback(
    request(
      `/api/auth/callback?error=access_denied&state=${transaction.state}`,
      cookie
    ),
    env
  )
  assert.equal(response.status, 401)
  assert.match(
    await response.text(),
    new RegExp(`href="/api/account/auth/login\\?code=${pairingCode}"`)
  )
  assert.equal(exchanges.length, 0)
})
test("all customer portal shell URLs require a verified account session and keep private headers", async () => {
  for (const path of [
    "/account",
    "/account/",
    "/account.html",
    "/account.txt",
    "/account/__next._full.txt",
    "/account/__next.account.__PAGE__.txt",
    "/account/__next._tree.txt",
  ]) {
    let served = false
    let response = await accountMiddleware({
      request: request(path),
      env,
      next: () => {
        served = true
        return new Response("account shell")
      },
    })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "/api/account/auth/login")
    assert.equal(served, false)
    response = await accountMiddleware({
      request: request(path, await sessionCookie()),
      env,
      next: () => {
        served = true
        return new Response("account shell")
      },
    })
    assert.equal(response.status, 200)
    assert.equal(served, true)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow")
  }
})
test("retired reminder administration retains Owner authentication without sending mail", async () => {
  for (const cookie of [
    undefined,
    await sessionCookie(),
    await sessionCookie("admin", { org_id: organizationId, role: "member" }),
  ]) {
    const denied = await handleAdminReminders(
      request("/api/admin/subscription-reminders", cookie),
      env
    )
    assert.ok([401, 403].includes(denied.status))
  }
  const owner = await sessionCookie("admin", {
    org_id: organizationId,
    role: "owner",
  })
  const queue = await handleAdminReminders(
    request("/api/admin/subscription-reminders", owner),
    env
  )
  assert.equal(queue.status, 410)
  assert.match((await queue.json()).error, /retired/)
  const make = (originHeader) =>
    new Request(`${origin}/api/admin/subscription-reminders`, {
      method: "POST",
      headers: {
        cookie: owner,
        origin: originHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "run" }),
    })
  assert.equal(
    (await handleAdminReminders(make("https://attacker.example"), env)).status,
    410
  )
  assert.equal((await handleAdminReminders(make(origin), env)).status, 410)
})
test("successful account sign-in and later logins never grant a subscription", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const flow = await beginAccount()
    const response = await callback(flow.cookie, flow.transaction.state)
    assert.equal(response.status, 303)
    assert.ok(responseCookie(response, "__Host-photodepot-account"))
    assert.equal(await getSubscription(env.DB, user.id), null)
    assert.deepEqual(await listSubscriptionAudit(env.DB, user.id), [])
  }
})
test("account sign-in preserves Owner-assigned Trial and Standard grants and revocations", async () => {
  let expectedRevision = 0
  for (const type of ["trial", "regular"]) {
    const assigned = await setSubscription(
      env.DB,
      {
        userId: user.id,
        type,
        endsAt: Date.now() + 3 * 86_400_000,
        expectedRevision,
      },
      "owner@example.test"
    )
    let flow = await beginAccount()
    assert.equal(
      (await callback(flow.cookie, flow.transaction.state)).status,
      303
    )
    assert.deepEqual(await getSubscription(env.DB, user.id), assigned)
    assert.equal(
      (await listSubscriptionAudit(env.DB, user.id)).length,
      assigned.revision
    )
    const revoked = await changeSubscription(
      env.DB,
      user.id,
      "revoke",
      assigned.revision,
      "owner@example.test"
    )
    flow = await beginAccount()
    assert.equal(
      (await callback(flow.cookie, flow.transaction.state)).status,
      303
    )
    assert.deepEqual(await getSubscription(env.DB, user.id), revoked)
    assert.equal(
      (await listSubscriptionAudit(env.DB, user.id)).length,
      revoked.revision
    )
    expectedRevision = revoked.revision
  }
})
test("account callback rejects unverified email and tokens bound to another client or user", async () => {
  for (const mismatch of ["unverified", "client", "user"]) {
    tokenClaims =
      mismatch === "client"
        ? { client_id: "client_other" }
        : mismatch === "user"
          ? { sub: "user_other" }
          : {}
    returnedUser = { ...user, email_verified: mismatch !== "unverified" }
    const { cookie, transaction } = await beginAccount()
    const response = await callback(cookie, transaction.state)
    assert.equal(response.status, 401)
    assert.equal(await getSubscription(env.DB, user.id), null)
    assert.equal(
      responseCookie(response, "__Host-photodepot-account"),
      undefined
    )
  }
})
test("missing, forged, expired and mismatched account transactions never exchange a code", async () => {
  const { cookie, transaction } = await beginAccount()
  const path = `/api/auth/callback?code=test-account-code&state=${transaction.state}`
  for (const [url, supplied] of [
    [path, undefined],
    [path, "__Host-photodepot-account-login=forged"],
    [path, `${cookie}; ${cookie}`],
    ["/api/auth/callback?code=test-account-code&state=wrong", cookie],
    [
      `/api/auth/callback?error=access_denied&state=${transaction.state}`,
      cookie,
    ],
  ])
    assert.equal(
      (await handleAdminCallback(request(url, supplied), env)).status,
      401
    )
  const originalNow = Date.now
  let expired
  try {
    Date.now = () => originalNow() - 1200_000
    expired = await sealData(transaction, { password, ttl: 600 })
  } finally {
    Date.now = originalNow
  }
  assert.equal(
    (
      await handleAdminCallback(
        request(path, `__Host-photodepot-account-login=${expired}`),
        env
      )
    ).status,
    401
  )
  for (const mismatch of [
    { clientId: "client_elsewhere" },
    { origin: "https://attacker.example" },
  ]) {
    const seal = await sealData(
      { ...transaction, ...mismatch },
      { password, ttl: 600 }
    )
    assert.equal(
      (
        await handleAdminCallback(
          request(path, `__Host-photodepot-account-login=${seal}`),
          env
        )
      ).status,
      401
    )
  }
  assert.equal(exchanges.length, 0)
})
test("account transactions cannot return outside the portal or exact Mac activation route", async () => {
  const { transaction } = await beginAccount()
  for (const returnPath of [
    undefined,
    "/",
    "//attacker.example",
    "/admin/subscriptions",
    "/account/activate?code=short",
    `${activationPath}&next=//attacker.example`,
  ]) {
    const seal = await sealData(
      { ...transaction, returnPath },
      { password, ttl: 600 }
    )
    const response = await callback(
      `__Host-photodepot-account-login=${seal}`,
      transaction.state
    )
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("location"), null)
    assert.equal(
      responseCookie(response, "__Host-photodepot-account"),
      undefined
    )
  }
})
test("login transaction cookies cannot be renamed across admin and account audiences", async () => {
  const customer = await beginAccount()
  const adminResponse = await handleAdminLogin(request("/api/auth/login"), env)
  const adminCookie = cookiePair(
    responseCookie(adminResponse, "__Host-photodepot-login")
  )
  const admin = await unsealData(cookieValue(adminCookie), {
    password,
    ttl: 600,
  })
  for (const [cookie, transaction] of [
    [
      `__Host-photodepot-login=${cookieValue(customer.cookie)}`,
      customer.transaction,
    ],
    [`__Host-photodepot-account-login=${cookieValue(adminCookie)}`, admin],
  ])
    assert.equal((await callback(cookie, transaction.state)).status, 401)
  assert.equal(exchanges.length, 0)
})
test("simultaneous login flows select and clear only their matching transaction", async () => {
  const adminResponse = await handleAdminLogin(request("/api/auth/login"), env)
  const adminCookie = cookiePair(
    responseCookie(adminResponse, "__Host-photodepot-login")
  )
  const admin = await unsealData(cookieValue(adminCookie), {
    password,
    ttl: 600,
  })
  const customer = await beginAccount()
  const response = await callback(
    `${adminCookie}; ${customer.cookie}`,
    customer.transaction.state
  )
  assert.equal(response.headers.get("location"), activationPath)
  assert.equal(responseCookie(response, "__Host-photodepot-admin"), undefined)
  assert.equal(
    response.headers
      .getSetCookie()
      .some((value) => value.startsWith("__Host-photodepot-login=")),
    false
  )
  expectedVerifier = admin.codeVerifier
  tokenClaims = { org_id: organizationId, role: "owner" }
  const owner = await callback(
    `${adminCookie}; ${customer.cookie}`,
    admin.state
  )
  assert.equal(owner.headers.get("location"), "/admin")
  assert.ok(responseCookie(owner, "__Host-photodepot-admin"))
  assert.equal(
    owner.headers
      .getSetCookie()
      .some((value) => value.startsWith("__Host-photodepot-account-login=")),
    false
  )
})
test("sealed sessions are audience-bound even when an account token has the Owner role", async () => {
  const claims = { org_id: organizationId, role: "owner" }
  const customerCookie = await sessionCookie("account", claims)
  const adminCookie = await sessionCookie("admin", claims)
  const renamedAccount = `__Host-photodepot-admin=${cookieValue(customerCookie)}`
  const renamedAdmin = `__Host-photodepot-account=${cookieValue(adminCookie)}`
  assert.equal(
    (
      await authenticateLicenseAdmin(
        request("/api/admin/subscriptions", renamedAccount),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (
      await authenticateWorkOSAccount(
        request("/api/account/device", renamedAdmin),
        env
      )
    ).status,
    401
  )
  const legacyAdmin = await sessionCookie("admin", claims, {
    audience: undefined,
  })
  assert.equal(
    (
      await authenticateWorkOSAccount(
        request(
          "/api/account/device",
          `__Host-photodepot-account=${cookieValue(legacyAdmin)}`
        ),
        env
      )
    ).status,
    401
  )
})
test("account refresh does not pin the admin organization and propagates only an account cookie", async () => {
  const cookie = await sessionCookie("account", { exp: 1 })
  const auth = await authenticateWorkOSAccount(
    request("/api/account/device", cookie),
    env
  )
  assert.equal(auth.userId, user.id)
  assert.ok(auth.setCookie.startsWith("__Host-photodepot-account="))
  assert.match(auth.setCookie, /HttpOnly/)
  const session = await unsealData(cookieValue(cookiePair(auth.setCookie)), {
    password,
    ttl: 604800,
  })
  assert.equal(session.audience, "account")
  assert.equal(session.refreshToken, "refresh-account-rotated")
  assert.equal(exchanges.length, 1)
})
test("account refresh outages preserve the existing cookie and never authorize expired access", async () => {
  const cookie = await sessionCookie("account", { exp: 1 })
  for (const status of [429, 503]) {
    failRefresh = status
    const response = await authenticateWorkOSAccount(
      request("/api/account/device", cookie),
      env
    )
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("set-cookie"), null)
  }
})
test("account routes require a valid activation code, correct method, origin and configured hostname", async () => {
  for (const code of ["", "short", "A".repeat(44), "!".repeat(43)])
    assert.equal(
      (
        await handleAccountLogin(
          request(`/api/account/auth/login?code=${encodeURIComponent(code)}`),
          env
        )
      ).status,
      400
    )
  assert.equal(
    (
      await handleAccountLogin(
        request(
          `/api/account/auth/login?code=${pairingCode}`,
          undefined,
          "POST"
        ),
        env
      )
    ).status,
    405
  )
  assert.equal(
    (await handleAccountLogout(request("/api/account/auth/logout"), env))
      .status,
    405
  )
  for (const originHeader of [undefined, "null", "https://attacker.example"]) {
    const response = await handleAccountLogout(
      new Request(`${origin}/api/account/auth/logout`, {
        method: "POST",
        headers: {
          referer: `${origin}${activationPath}`,
          ...(originHeader ? { origin: originHeader } : {}),
        },
      }),
      env
    )
    assert.equal(response.status, 403)
  }
  assert.equal(
    (
      await handleAccountLogin(
        request(
          `/api/account/auth/login?code=${pairingCode}`,
          undefined,
          "GET",
          "https://photodepot-web.pages.dev"
        ),
        env
      )
    ).status,
    403
  )
  assert.equal(
    (
      await authenticateWorkOSAccount(request("/api/account/device"), {
        ...env,
        WORKOS_COOKIE_PASSWORD: "",
      })
    ).status,
    503
  )
})
test("Pages account route adapters set account cookies and sign out expired hosted sessions", async () => {
  const login = await loginRoute({
    request: request(`/api/account/auth/login?code=${pairingCode}`),
    env,
  })
  assert.equal(login.status, 302)
  assert.ok(responseCookie(login, "__Host-photodepot-account-login"))
  const cookie = await sessionCookie("account", { exp: 1 })
  const logout = await logoutRoute({
    request: request("/api/account/auth/logout", cookie, "POST"),
    env,
  })
  assert.equal(logout.status, 200)
  const html = await logout.text()
  assert.match(html, /http-equiv="refresh"/)
  assert.equal(logout.headers.get("referrer-policy"), "no-referrer")
  const target = new URL(
    html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&")
  )
  assert.equal(target.origin, "https://api.workos.com")
  assert.equal(
    target.searchParams.get("session_id"),
    "session_account_customer"
  )
  assert.equal(target.searchParams.get("return_to"), `${origin}/`)
  assert.ok(
    logout.headers
      .getSetCookie()
      .every(
        (value) =>
          value.includes("Max-Age=0") &&
          value.startsWith("__Host-photodepot-account")
      )
  )
  assert.equal(exchanges.length, 0)
})
