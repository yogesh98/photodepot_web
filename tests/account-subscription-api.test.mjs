import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { sealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAccountSubscription } from "../functions/api/account/subscription.ts"
import { handleAdminSubscriptionRequests } from "../functions/api/admin/subscription-requests.ts"
import { bindSubscriptionDevice } from "../lib/subscription-devices.ts"
import { getSubscription, setSubscription } from "../lib/subscription-store.ts"

const origin = "https://photodepot.app"
const clientId = "client_account_dashboard_api"
const organization = "org_account_dashboard_admin"
const password = "account-dashboard-secret-at-least-32-characters"
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "account-dashboard-jwk",
  use: "sig",
  alg: "RS256",
}
const macKey = generateKeyPairSync("ed25519")
  .publicKey.export({ format: "der", type: "spki" })
const deviceId = createHash("sha256").update(macKey).digest("hex")
const publicKey = macKey.toString("base64url")
let platform, env, originalFetch
function token(userId, role = "member") {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: userId,
      sid: "session_dashboard",
      org_id: organization,
      role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}
async function cookie(
  userId = "user_dashboard_customer",
  audience = "account",
  role = "member",
  verified = true
) {
  const value = await sealData(
    {
      version: 1,
      audience,
      clientId,
      origin,
      accessToken: token(userId, role),
      refreshToken: "fixture_refresh",
      user: {
        id: userId,
        email: `${userId}@example.test`,
        emailVerified: verified,
      },
    },
    { password, ttl: 604800 }
  )
  return `__Host-photodepot-${audience}=${value}`
}
function request(path, cookie, body, changes = {}) {
  return new Request(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json", ...changes },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = {
    ...platform.env,
    WORKOS_CLIENT_ID: clientId,
    WORKOS_ADMIN_ORGANIZATION_ID: organization,
    WORKOS_COOKIE_PASSWORD: password,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    PHOTODEPOT_ENVIRONMENT: "development",
  }
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
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `https://api.workos.com/sso/jwks/${clientId}`)
    return Response.json({ keys: [jwk] })
  }
})
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM subscription_request_audit",
      "DELETE FROM subscription_requests",
      "DELETE FROM account_devices",
      "DELETE FROM subscription_audit",
      "DELETE FROM subscriptions",
    ].map((sql) => env.DB.prepare(sql))
  )
  for (const userId of ["user_dashboard_customer", "user_dashboard_other"])
    await setSubscription(
      env.DB,
      {
        userId,
        type: "trial",
        endsAt: Date.now() + 7 * 86_400_000,
        expectedRevision: 0,
        notes: "Never expose admin-only notes",
      },
      "owner@example.test"
    )
  await bindSubscriptionDevice(env.DB, {
    userId: "user_dashboard_customer",
    deviceId,
    publicKey,
  })
})
after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})

test("customer GET shows only the authenticated account and no administrator data", async () => {
  const response = await handleAccountSubscription(
    request(
      "/api/account/subscription?userId=user_dashboard_other",
      await cookie()
    ),
    env
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const account = await response.json()
  assert.equal(account.user.email, "user_dashboard_customer@example.test")
  assert.equal(account.environment, "development")
  assert.equal(account.subscription.deviceLimit, 2)
  assert.deepEqual(
    account.subscription.devices.map((device) => device.id),
    [deviceId]
  )
  assert.equal(JSON.stringify(account).includes("Never expose"), false)
  for (const key of [
    "notes",
    "revision",
    "bindingRevision",
    "publicKey",
    "audit",
    "userId",
  ])
    assert.equal(key in account.subscription, false)
  assert.deepEqual(
    Object.keys(account.subscription.devices[0]).sort(),
    ["id", "activatedAt"].sort()
  )
})

test("account and admin cookies remain separate, and member sessions cannot review requests", async () => {
  const admin = await cookie("user_dashboard_owner", "admin", "owner")
  const memberAdmin = await cookie("user_dashboard_customer", "admin", "member")
  const account = await cookie()
  assert.equal(
    (
      await handleAccountSubscription(
        request("/api/account/subscription", admin),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (
      await handleAccountSubscription(
        request("/api/account/subscription", ""),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (
      await handleAccountSubscription(
        request(
          "/api/account/subscription",
          await cookie("user_dashboard_customer", "account", "member", false)
        ),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (
      await handleAdminSubscriptionRequests(
        request("/api/admin/subscription-requests", account),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (
      await handleAdminSubscriptionRequests(
        request("/api/admin/subscription-requests", memberAdmin),
        env
      )
    ).status,
    403
  )
  assert.equal(
    (
      await handleAdminSubscriptionRequests(
        request("/api/admin/subscription-requests", admin),
        env
      )
    ).status,
    200
  )
})

test("renewal and selected-Mac requests are idempotent and never mutate access", async () => {
  const auth = await cookie()
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  const body = {
    action: "request-device-reset",
    deviceId,
    message: "<script>window.injected=true</script>",
  }
  const created = await handleAccountSubscription(
    request("/api/account/subscription", auth, body),
    env
  )
  assert.equal(created.status, 201)
  const result = await created.json()
  assert.equal(result.request.deviceId, deviceId)
  assert.equal(result.request.message, body.message)
  const retry = await handleAccountSubscription(
    request("/api/account/subscription", auth, body),
    env
  )
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).created, false)
  const renewal = await handleAccountSubscription(
    request("/api/account/subscription", auth, { action: "request-renewal" }),
    env
  )
  assert.equal(renewal.status, 201)
  assert.deepEqual(
    await getSubscription(env.DB, "user_dashboard_customer"),
    before
  )
  const other = await handleAccountSubscription(
    request("/api/account/subscription", await cookie("user_dashboard_other")),
    env
  )
  assert.equal((await other.json()).requests.length, 0)
})

test("request writes enforce own-device membership, CSRF, body and text limits", async () => {
  const auth = await cookie()
  for (const body of [
    { action: "request-device-reset", deviceId: "f".repeat(64) },
    { action: "request-renewal", userId: "user_dashboard_other" },
    { action: "request-renewal", message: "x".repeat(1001) },
    { action: "request-renewal", deviceId },
    { action: "revoke" },
  ])
    assert.equal(
      (
        await handleAccountSubscription(
          request("/api/account/subscription", auth, body),
          env
        )
      ).status,
      400
    )
  assert.equal(
    (
      await handleAccountSubscription(
        request(
          "/api/account/subscription",
          auth,
          { action: "request-renewal" },
          { origin: "https://other.example" }
        ),
        env
      )
    ).status,
    403
  )
  assert.equal(
    (
      await handleAccountSubscription(
        request(
          "/api/account/subscription",
          auth,
          { action: "request-renewal" },
          { "content-type": "text/plain" }
        ),
        env
      )
    ).status,
    415
  )
  assert.equal(
    (
      await handleAccountSubscription(
        new Request(`${origin}/api/account/subscription`, {
          method: "POST",
          headers: { cookie: auth, origin, "content-type": "application/json" },
          body: "x".repeat(8193),
        }),
        env
      )
    ).status,
    413
  )
  const data = await (
    await handleAccountSubscription(
      request("/api/account/subscription", auth),
      env
    )
  ).json()
  assert.equal(data.requests.length, 0)
})

test("Owner request review is revision-safe and hides review notes from customers", async () => {
  const auth = await cookie()
  const created = await (
    await handleAccountSubscription(
      request("/api/account/subscription", auth, { action: "request-renewal" }),
      env
    )
  ).json()
  const admin = await cookie("user_dashboard_owner", "admin", "owner")
  const review = {
    action: "acknowledge",
    requestId: created.request.id,
    expectedRevision: 1,
    note: "Admin-only followup",
  }
  const response = await handleAdminSubscriptionRequests(
    request("/api/admin/subscription-requests", admin, review),
    env
  )
  assert.equal(response.status, 200)
  assert.equal((await response.json()).request.revision, 2)
  assert.equal(
    (
      await handleAdminSubscriptionRequests(
        request("/api/admin/subscription-requests", admin, {
          ...review,
          action: "resolve",
        }),
        env
      )
    ).status,
    409
  )
  assert.equal(
    (
      await handleAdminSubscriptionRequests(
        request(
          "/api/admin/subscription-requests",
          admin,
          { ...review, action: "resolve", expectedRevision: 2 },
          { origin: "null" }
        ),
        env
      )
    ).status,
    403
  )
  const history = await (
    await handleAdminSubscriptionRequests(
      request(
        `/api/admin/subscription-requests?requestId=${created.request.id}`,
        admin
      ),
      env
    )
  ).json()
  assert.equal(history.audit.length, 2)
  assert.equal(history.request.adminNote, "Admin-only followup")
  const customer = await (
    await handleAccountSubscription(
      request("/api/account/subscription", auth),
      env
    )
  ).json()
  assert.equal(customer.requests[0].status, "acknowledged")
  assert.equal(JSON.stringify(customer).includes("Admin-only"), false)
  assert.equal("audit" in customer, false)
})
