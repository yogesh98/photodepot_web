import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { sealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAccountSubscription } from "../functions/api/account/subscription.ts"
import { handleAdminSubscriptionRequests } from "../functions/api/admin/subscription-requests.ts"
import { getSubscription, setSubscription } from "../lib/subscription-store.ts"
import {
  createAccountRequest,
  getAccountRequest,
} from "../lib/account-requests.ts"

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
const vendor = generateKeyPairSync("ed25519")
const mac = generateKeyPairSync("ed25519")
const macKey = mac.publicKey.export({
  format: "der",
  type: "spki",
})
const deviceId = createHash("sha256").update(macKey).digest("hex")
const publicKey = macKey.toString("base64url")
let platform, env, originalFetch
const liveUsers = new Map()
const accountLookups = []
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
    WORKOS_API_KEY: "sk_test_account_dashboard_api",
    WORKOS_ADMIN_ORGANIZATION_ID: organization,
    WORKOS_COOKIE_PASSWORD: password,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
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
    if (String(input) === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    const id = new URL(input).pathname.split("/").at(-1)
    assert.equal(
      String(input),
      `https://api.workos.com/user_management/users/${id}`
    )
    accountLookups.push(id)
    const user = liveUsers.get(id)
    if (!user)
      return Response.json({ message: "User not found" }, { status: 404 })
    if (user === "unavailable")
      return Response.json({ message: "Unavailable" }, { status: 503 })
    return Response.json({
      object: "user",
      id,
      email: user.email,
      email_verified: user.emailVerified,
      first_name: user.firstName,
      last_name: user.lastName,
      created_at: user.createdAt,
      updated_at: user.createdAt,
    })
  }
})
beforeEach(async () => {
  liveUsers.clear()
  accountLookups.length = 0
  liveUsers.set("user_dashboard_customer", {
    email: "live.customer@example.test",
    emailVerified: false,
    firstName: "Actual",
    lastName: "Customer",
    createdAt: "2026-01-02T03:04:05.000Z",
  })
  await env.DB.batch(
    [
      "DELETE FROM workos_entitlements",
      "DELETE FROM workos_billing_sessions",
      "DELETE FROM stripe_customers",
      "DELETE FROM subscription_request_audit",
      "DELETE FROM subscription_requests",
      "DELETE FROM account_pairings",
      "DELETE FROM account_device_audit",
      "DELETE FROM desktop_sessions",
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
  await env.DB.prepare(
    `INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,created_at,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000001',?,'user_dashboard_customer','customer@example.test',?,?,?)`
  )
    .bind(deviceId, publicKey, Date.now(), Date.now())
    .run()
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
  assert.equal(account.access.canHost, true)
  assert.deepEqual(
    account.devices.map((device) => device.id),
    [deviceId]
  )
  assert.equal(JSON.stringify(account).includes("Never expose"), false)
  for (const key of [
    "notes",
    "bindingRevision",
    "publicKey",
    "audit",
    "userId",
  ])
    assert.equal(key in account.access, false)
  assert.deepEqual(
    Object.keys(account.devices[0]).sort(),
    [
      "id",
      "activatedAt",
      "sessionId",
      "revision",
      "deviceName",
      "lastUsedAt",
    ].sort()
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

test("renewal requests are idempotent and never mutate access", async () => {
  const auth = await cookie()
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  const body = {
    action: "request-renewal",
    message: "<script>window.injected=true</script>",
  }
  const created = await handleAccountSubscription(
    request("/api/account/subscription", auth, body),
    env
  )
  assert.equal(created.status, 201)
  const result = await created.json()
  assert.equal(result.request.deviceId, null)
  assert.equal(result.request.message, body.message)
  const retry = await handleAccountSubscription(
    request("/api/account/subscription", auth, body),
    env
  )
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).created, false)
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

test("admin request queue uses live account metadata, deduplicates lookups and marks deleted accounts", async () => {
  for (const values of [
    { action: "renewal" },
    { action: "reset-device", deviceId },
    { userId: "user_dashboard_other", action: "renewal" },
  ])
    await createAccountRequest(env.DB, {
      userId: "user_dashboard_customer",
      email: "stored.old.email@example.test",
      ...values,
    })
  const response = await handleAdminSubscriptionRequests(
    request(
      "/api/admin/subscription-requests",
      await cookie("user_dashboard_owner", "admin", "owner")
    ),
    env
  )
  assert.equal(response.status, 200)
  const queue = await response.json()
  assert.equal(queue.requests.length, 3)
  for (const item of queue.requests.filter(
    (item) => item.userId === "user_dashboard_customer"
  )) {
    assert.deepEqual(item.user, {
      id: "user_dashboard_customer",
      email: "live.customer@example.test",
      emailVerified: false,
      firstName: "Actual",
      lastName: "Customer",
      createdAt: Date.parse("2026-01-02T03:04:05.000Z"),
    })
    assert.equal(item.email, "stored.old.email@example.test")
  }
  assert.equal(
    queue.requests.find((item) => item.userId === "user_dashboard_other").user,
    null
  )
  assert.deepEqual(accountLookups.sort(), [
    "user_dashboard_customer",
    "user_dashboard_other",
  ])
  liveUsers.set("user_dashboard_customer", "unavailable")
  const unavailable = await handleAdminSubscriptionRequests(
    request(
      "/api/admin/subscription-requests",
      await cookie("user_dashboard_owner", "admin", "owner")
    ),
    env
  )
  assert.equal(unavailable.status, 503)
})

test("former profile settings do not alter customer requests or Owner reviews", async () => {
  const bindings = { ...env, PHOTODEPOT_ENVIRONMENT: "staging" }
  const customer = await cookie()
  const write = await handleAccountSubscription(
    request("/api/account/subscription", customer, {
      action: "request-renewal",
    }),
    bindings
  )
  assert.equal(write.status, 201)
  const { request: created } = await write.json()
  const review = await handleAdminSubscriptionRequests(
    request(
      "/api/admin/subscription-requests",
      await cookie("user_dashboard_owner", "admin", "owner"),
      {
        requestId: created.id,
        action: "resolve",
        expectedRevision: 1,
      }
    ),
    bindings
  )
  assert.equal(review.status, 200)
  assert.deepEqual(await getAccountRequest(env.DB, created.id), {
    ...created,
    ...(await review.json()).request,
    status: "resolved",
    revision: 2,
  })
})

test("reminder preference responses preserve effective WorkOS access and independent manual revisions", async () => {
  const userId = "user_dashboard_customer",
    now = Date.now(),
    day = 86_400_000
  await env.DB.prepare("UPDATE subscriptions SET end_at=? WHERE user_id=?")
    .bind(now + day, userId)
    .run()
  const manual = await getSubscription(env.DB, userId, now)
  await env.DB.prepare(
    "INSERT INTO stripe_customers (user_id,stripe_customer_id,workos_organization_id,customer_create_token) VALUES (?,?,?,?)"
  )
    .bind(userId, "cus_preference", "org_preference", "fixture")
    .run()
  await env.DB.prepare(
    "INSERT INTO workos_billing_sessions (user_id,session_id,encrypted_tokens,updated_at) VALUES (?,?,?,?)"
  )
    .bind(userId, "session_preference", "unused-until-refresh", now)
    .run()
  await env.DB.prepare(
    "INSERT INTO workos_entitlements (user_id,organization_id,enabled,issued_at,expires_at,revision,context) VALUES (?,?,1,?,?,1,?)"
  )
    .bind(
      userId,
      "org_preference",
      now,
      now + 300_000,
      JSON.stringify([
        env.WORKOS_CLIENT_ID,
        env.PHOTODEPOT_WORKOS_ENTITLEMENT ?? "photodepot-standard",
      ])
    )
    .run()
  const response = await handleAccountSubscription(
    request("/api/account/subscription", await cookie(userId), {
      action: "set-reminders",
      enabled: false,
      expectedRevision: manual.revision,
    }),
    env
  )
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.access.source, "workos")
  assert.equal(result.access.canHost, true)
  assert.equal(result.reminders.enabled, false)
  assert.equal(result.reminders.revision, manual.revision + 1)
  assert.equal((await getSubscription(env.DB, userId)).endsAt, manual.endsAt)
})
