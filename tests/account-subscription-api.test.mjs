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
  assert.equal(account.access.canHost, false)
  assert.deepEqual(Object.keys(account).sort(), ["access", "devices", "user"])
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
    410
  )
})

test("retired customer actions cannot create requests, change manual grants or preferences", async () => {
  const auth = await cookie()
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  for (const action of [
    "request-renewal",
    "request-reset-device",
    "reset-device",
    "set-reminders",
  ]) {
    const result = await handleAccountSubscription(
      request("/api/account/subscription", auth, {
        action,
        enabled: false,
        expectedRevision: before.revision,
        message: "Give access",
      }),
      env
    )
    assert.equal(result.status, 410, action)
    assert.match((await result.json()).error, /retired/)
  }
  assert.deepEqual(
    await getSubscription(env.DB, "user_dashboard_customer"),
    before
  )
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM subscription_requests"
      ).first()
    ).n,
    0
  )
})

test("retired Owner request review leaves historical requests and audits unchanged", async () => {
  const stored = await createAccountRequest(env.DB, {
    userId: "user_dashboard_customer",
    email: "customer@example.test",
    action: "renewal",
  })
  const auth = await cookie("user_dashboard_owner", "admin", "owner")
  for (const body of [
    undefined,
    {
      action: "approve",
      id: stored.request.id,
      expectedRevision: 1,
      type: "regular",
      durationDays: 30,
    },
    { action: "reject", id: stored.request.id, expectedRevision: 1 },
  ]) {
    const response = await handleAdminSubscriptionRequests(
      request("/api/admin/subscription-requests", auth, body),
      env
    )
    assert.equal(response.status, 410)
  }
  assert.equal(
    (await getAccountRequest(env.DB, stored.request.id)).status,
    "pending"
  )
  assert.equal(accountLookups.length, 0)
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM subscription_request_audit"
      ).first()
    ).n,
    1
  )
})
