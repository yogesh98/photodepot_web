import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { sealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAdminSubscriptions } from "../functions/api/admin/subscriptions.ts"
import { handleAdminWaitlist } from "../functions/api/admin/waitlist.ts"
import { setSubscription } from "../lib/subscription-store.ts"
import { getAccountEntitlement } from "../lib/account-entitlement.ts"
import { workosBillingConfiguration } from "../lib/workos-entitlements.ts"

const origin = "https://photodepot.app"
const clientId = "client_subscription_api"
const billingClientId = "client_subscription_api_billing"
const organizationId = "org_subscription_api_admin"
const password = "subscription-api-cookie-fixture-at-least-32-characters"
const adminEmail = "owner@example.test"
const adminUserId = "user_api_owner"
const apiKey = "sk_test_subscription_api_fixture"
const day = 86_400_000
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "subscription-api-key",
  alg: "RS256",
  use: "sig",
}
let platform,
  env,
  originalFetch,
  workosUsers,
  userRequests,
  userFailure,
  billingFailure,
  listPageSize
function jwt(claims = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: adminUserId,
      sid: "session_subscription_api",
      org_id: organizationId,
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      ...claims,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}
function user(id, email) {
  return {
    object: "user",
    id,
    email,
    email_verified: true,
    first_name: "Test",
    last_name: "Customer",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
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
    WORKOS_BILLING_CLIENT_ID: billingClientId,
    WORKOS_ADMIN_ORGANIZATION_ID: organizationId,
    WORKOS_COOKIE_PASSWORD: password,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    WORKOS_API_KEY: apiKey,
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
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input))
    if (
      [clientId, billingClientId].some(
        (id) => url.href === `https://api.workos.com/sso/jwks/${id}`
      )
    )
      return Response.json({ keys: [jwk] })
    if (url.pathname === "/user_management/authenticate") {
      const body = JSON.parse(options.body)
      assert.equal(body.grant_type, "refresh_token")
      if (body.client_id === billingClientId) {
        assert.equal(billingFailure, 503)
        return Response.json(
          { message: "Fixture billing refresh outage" },
          { status: billingFailure }
        )
      }
      assert.equal(body.organization_id, organizationId)
      assert.equal("client_secret" in body, false)
      return Response.json({
        user: user(adminUserId, adminEmail),
        access_token: jwt(),
        refresh_token: "refreshed-api-token",
        authentication_method: "MagicAuth",
      })
    }
    assert.equal(url.origin, "https://api.workos.com")
    assert.equal(
      new Headers(options.headers).get("authorization"),
      `Bearer ${apiKey}`
    )
    userRequests.push(url)
    if (userFailure)
      return Response.json(
        { message: "Fixture user-management outage" },
        { status: userFailure }
      )
    if (url.pathname === "/user_management/users") {
      assert.equal(url.searchParams.get("limit"), "100")
      assert.equal(url.searchParams.has("organization_id"), false)
      const after = url.searchParams.get("after")
      const start = after
        ? workosUsers.findIndex((entry) => entry.id === after) + 1
        : 0
      const rows = workosUsers.slice(start, start + listPageSize)
      return Response.json({
        data: rows,
        list_metadata: {
          before: null,
          after:
            start + rows.length < workosUsers.length ? rows.at(-1).id : null,
        },
      })
    }
    const id = url.pathname.slice("/user_management/users/".length)
    assert.equal(url.pathname, `/user_management/users/${id}`)
    const found = workosUsers.find((entry) => entry.id === id)
    return found
      ? Response.json(found)
      : Response.json(
          { message: "User not found", code: "entity_not_found" },
          { status: 404 }
        )
  }
})
beforeEach(async () => {
  workosUsers = [
    user("user_api_trial", "trial@example.test"),
    user("user_api_regular", "regular@example.test"),
    user("user_api_other", "other@example.test"),
  ]
  userRequests = []
  userFailure = undefined
  billingFailure = undefined
  listPageSize = 100
  await env.DB.batch(
    [
      "DELETE FROM account_devices",
      "DELETE FROM account_device_audit",
      "DELETE FROM desktop_sessions",
      "DELETE FROM workos_entitlements",
      "DELETE FROM workos_billing_sessions",
      "DELETE FROM stripe_customers",
      "DELETE FROM account_entitlements",
      "DELETE FROM subscription_audit",
      "DELETE FROM subscriptions",
      "DELETE FROM waitlist",
    ].map((sql) => env.DB.prepare(sql))
  )
})
after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})
async function cookie(claims = {}, audience = "admin", sessionChanges = {}) {
  const sealed = await sealData(
    {
      version: 1,
      audience,
      clientId,
      origin,
      accessToken: jwt(claims),
      refreshToken: "api-refresh-token",
      user: { id: adminUserId, email: adminEmail, emailVerified: true },
      ...sessionChanges,
    },
    { password, ttl: 604800 }
  )
  return `__Host-photodepot-${audience}=${sealed}`
}
function request(
  query = "",
  body,
  headers = {},
  method = body ? "POST" : "GET"
) {
  return new Request(`${origin}/api/admin/subscriptions${query}`, {
    method,
    headers: { origin, "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
async function api(body, query = "", changes = {}) {
  return handleAdminSubscriptions(
    request(query, body, { cookie: await cookie(), ...changes }),
    env
  )
}
async function count(table) {
  return (
    await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()
  ).count
}
function setBody(userId = "user_api_trial", values = {}) {
  return {
    action: "set",
    userId,
    type: "trial",
    durationDays: 14,
    expectedRevision: 0,
    ...values,
  }
}

test("only a verified Owner session in the configured organization can read or mutate subscriptions", async () => {
  const accountCookie = await cookie({}, "account")
  for (const [supplied, status] of [
    [undefined, 401],
    ["__Host-photodepot-admin=forged", 401],
    [await cookie({}, "admin", { accessToken: "forged" }), 401],
    [await cookie({ role: "member" }), 403],
    [await cookie({ role: "admin" }), 403],
    [await cookie({ role: undefined, roles: [] }), 403],
    [await cookie({ role: "Owner" }), 403],
    [await cookie({ role: "member", roles: ["org-owner"] }), 403],
    [await cookie({ org_id: "org_other" }), 403],
    [await cookie({ client_id: "client_other" }), 401],
    [await cookie({ sub: "user_other" }), 401],
    [await cookie({ iss: "https://attacker.example" }), 401],
    [
      await cookie({}, "admin", {
        user: { id: adminUserId, email: adminEmail, emailVerified: false },
      }),
      401,
    ],
    [accountCookie, 401],
    [accountCookie.replace("photodepot-account=", "photodepot-admin="), 401],
  ]) {
    for (const body of [
      undefined,
      setBody(),
      ...["extend", "revoke", "restore"].map((action) =>
        setBody("user_api_trial", { action, expectedRevision: 1 })
      ),
    ]) {
      const response = await handleAdminSubscriptions(
        request("", body, supplied ? { cookie: supplied } : {}),
        env
      )
      assert.equal(response.status, status)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
    }
    const history = await handleAdminSubscriptions(
      request(
        "?history=1&userId=user_api_trial",
        undefined,
        supplied ? { cookie: supplied } : {}
      ),
      env
    )
    assert.equal(history.status, status)
  }
  assert.equal(userRequests.length, 0)
  assert.equal(await count("subscriptions"), 0)
  assert.equal(await count("subscription_audit"), 0)
})
test("listing WorkOS users is read-only and does not itself trigger signup trials", async () => {
  const response = await api()
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.users.length, 3)
  assert.equal(result.nextCursor, null)
  assert.ok(
    result.users.every(
      (entry) => entry.subscription === null && Number.isFinite(entry.createdAt)
    )
  )
  assert.deepEqual(result.users[0], {
    id: "user_api_trial",
    email: "trial@example.test",
    firstName: "Test",
    lastName: "Customer",
    emailVerified: true,
    createdAt: Date.parse(workosUsers[0].created_at),
    subscription: null,
    billing: null,
    managed: null,
    access: {
      tier: "free",
      status: "none",
      source: null,
      startsAt: null,
      endsAt: null,
      canUseLocal: false,
      canHost: false,
    },
    accessUnavailable: false,
    devices: [],
  })
  workosUsers.unshift(user("user_api_new", "new@example.test"))
  const refreshed = await (await api()).json()
  assert.equal(refreshed.users[0].id, "user_api_new")
  assert.equal(refreshed.users[0].subscription, null)
  assert.equal(await count("subscriptions"), 0)
  assert.equal(await count("subscription_audit"), 0)
})
test("user pagination uses the WorkOS cursor and rejects malformed cursors before lookup", async () => {
  listPageSize = 2
  const first = await (await api()).json()
  assert.equal(first.nextCursor, "user_api_regular")
  const second = await (
    await api(undefined, `?cursor=${first.nextCursor}`)
  ).json()
  assert.deepEqual(
    second.users.map((entry) => entry.id),
    ["user_api_other"]
  )
  assert.equal(second.nextCursor, null)
  const start = userRequests.length
  for (const cursor of [
    "invalid",
    "user_",
    "user_sql';DROP",
    "user_" + "a".repeat(121),
  ])
    assert.equal(
      (await api(undefined, `?cursor=${encodeURIComponent(cursor)}`)).status,
      400
    )
  assert.equal(userRequests.length, start)
})
test("user-list failures are service errors rather than empty account lists", async () => {
  userFailure = 503
  const outage = await api()
  assert.equal(outage.status, 503)
  const body = await outage.json()
  assert.equal("users" in body, false)
  userFailure = undefined
  const missingKey = await handleAdminSubscriptions(
    request("", undefined, { cookie: await cookie() }),
    { ...env, WORKOS_API_KEY: undefined }
  )
  assert.equal(missingKey.status, 503)
  assert.equal("users" in (await missingKey.json()), false)
})
test("refreshed Owner cookies propagate on successful reads and rejected mutations", async () => {
  for (const body of [undefined, setBody(undefined, { durationDays: 0 })]) {
    const response = await handleAdminSubscriptions(
      request("", body, { cookie: await cookie({ exp: 1 }) }),
      env
    )
    assert.equal(response.status, body ? 410 : 200)
    assert.ok(
      response.headers
        .getSetCookie()
        .some(
          (value) =>
            value.startsWith("__Host-photodepot-admin=") &&
            value.includes("HttpOnly")
        )
    )
  }
})

test("waitlist is Owner-only, globally searchable, paginated and counted independently of the current page", async () => {
  const path = `${origin}/api/admin/waitlist`
  for (const [value, status] of [
    [undefined, 401],
    [await cookie({}, "account"), 401],
    [await cookie({ role: "member" }), 403],
  ]) {
    const response = await handleAdminWaitlist(
      new Request(path, { headers: value ? { cookie: value } : {} }),
      env
    )
    assert.equal(response.status, status)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  const now = Date.now()
  await env.DB.batch(
    Array.from({ length: 55 }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO waitlist (first_name,last_name,email,heard_about_us,created_at) VALUES (?,?,?,?,?)"
      ).bind(
        `Person ${index}`,
        index === 0 ? "Unique" : null,
        `wait${index}@example.test`,
        index % 2 ? "Friend" : "Search",
        new Date(now - (index < 5 ? 40 : 1) * day).toISOString()
      )
    )
  )
  const owner = await cookie()
  const read = (query = "") =>
    handleAdminWaitlist(
      new Request(path + query, { headers: { cookie: owner } }),
      env
    )
  const firstResponse = await read()
  assert.equal(firstResponse.headers.get("cache-control"), "private, no-store")
  const first = await firstResponse.json()
  assert.equal(first.entries.length, 50)
  assert.equal(first.totalMatches, 55)
  assert.equal(first.overview.total, 55)
  assert.equal(first.overview.last30Days, 50)
  assert.equal(
    first.overview.sources.reduce((sum, item) => sum + item.count, 0),
    55
  )
  const second = await (await read(`?cursor=${first.nextCursor}`)).json()
  assert.equal(second.entries.length, 5)
  assert.equal(second.nextCursor, null)
  assert.equal(
    new Set([...first.entries, ...second.entries].map(({ id }) => id)).size,
    55
  )
  const search = await (await read("?q=unique")).json()
  assert.equal(search.entries[0].email, "wait0@example.test")
  assert.equal(search.totalMatches, 1)
  assert.equal(search.overview.total, 55)
  assert.equal(typeof search.entries[0].createdAt, "number")
  const percent = await (await read("?q=%25")).json()
  assert.equal(percent.totalMatches, 0)
  for (const query of [
    "?cursor=-1",
    "?cursor=1.5",
    "?cursor=bad",
    "?cursor=9007199254740992",
  ])
    assert.equal((await read(query)).status, 400)
  assert.equal(
    (
      await handleAdminWaitlist(
        new Request(path, { method: "POST", headers: { cookie: owner } }),
        env
      )
    ).status,
    405
  )
  const overview = (await (await api()).json()).overview
  assert.equal(overview.waitlistTotal, 55)
  assert.equal(overview.waitlistLast30Days, 50)
})

test("manual administration is retired without changing stored grants or audit history", async () => {
  const grant = await setSubscription(
    env.DB,
    {
      userId: "user_api_trial",
      type: "trial",
      endsAt: Date.now() + day,
      expectedRevision: 0,
    },
    adminEmail
  )
  const before = (await env.DB.prepare("SELECT * FROM subscriptions").all())
    .results
  const audits = (
    await env.DB.prepare("SELECT * FROM subscription_audit").all()
  ).results
  const lookups = userRequests.length
  for (const action of [
    "set",
    "extend",
    "revoke",
    "restore",
    "update-notes",
    "set-reminders",
    "approve",
  ]) {
    const result = await api({
      action,
      userId: grant.userId,
      expectedRevision: grant.revision,
      durationDays: 30,
      type: "regular",
      enabled: true,
      notes: "Ignored",
    })
    assert.equal(result.status, 410, action)
    assert.match((await result.json()).error, /retired/)
  }
  assert.deepEqual(
    (await env.DB.prepare("SELECT * FROM subscriptions").all()).results,
    before
  )
  assert.deepEqual(
    (await env.DB.prepare("SELECT * FROM subscription_audit").all()).results,
    audits
  )
  assert.equal(userRequests.length, lookups)
  const detail = await (
    await api(undefined, "?history=1&userId=user_api_trial")
  ).json()
  assert.equal(detail.subscription.id, grant.id)
  assert.equal(detail.access.canHost, false)
  assert.equal("requests" in detail, false)
  const page = await (await api()).json()
  assert.equal(page.billingMode, "subscriptions")
  assert.equal(page.overview.active, 0)
  assert.equal(page.overview.totalSubscriptions, 0)
})

test("remaining device administration retains origin, body size and method checks", async () => {
  assert.equal(
    (
      await api({ action: "remove-device", userId: "user_api_trial" }, "", {
        origin: "https://attacker.example",
      })
    ).status,
    403
  )
  const oversized = await handleAdminSubscriptions(
    new Request(origin + "/api/admin/subscriptions", {
      method: "POST",
      headers: {
        cookie: await cookie(),
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "remove-device",
        padding: "x".repeat(20_000),
      }),
    }),
    env
  )
  assert.equal(oversized.status, 413)
  assert.equal(
    (
      await handleAdminSubscriptions(
        request("", undefined, { cookie: await cookie() }, "DELETE"),
        env
      )
    ).status,
    405
  )
})

test("billing refresh outages preserve admin account history and device removal without authorizing access", async () => {
  const userId = "user_api_trial"
  const now = Date.now()
  const personalOrganization = "org_api_personal"
  const backendSid = "session_api_billing"
  const desktopSessionId = randomUUID()
  const grant = await setSubscription(
    env.DB,
    {
      userId,
      type: "regular",
      endsAt: now + day,
      expectedRevision: 0,
      notes: "Historical support notes",
    },
    adminEmail
  )
  const encrypted = await sealData(
    {
      version: 1,
      purpose: "photodepot-billing-auth",
      clientId: billingClientId,
      userId,
      organizationId: personalOrganization,
      sessionId: backendSid,
      accessToken: jwt({
        client_id: billingClientId,
        sub: userId,
        sid: backendSid,
        org_id: personalOrganization,
        iat: Math.floor(now / 1000) - 60,
        exp: Math.floor(now / 1000) - 1,
        entitlements: ["photodepot-standard"],
      }),
      refreshToken: "billing_refresh_fixture",
    },
    { password, ttl: 0 }
  )
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO stripe_customers (user_id,stripe_customer_id,workos_organization_id,customer_create_token) VALUES (?,?,?,?)"
    ).bind(userId, "cus_api_fixture", personalOrganization, "create_fixture"),
    env.DB.prepare(
      "INSERT INTO workos_billing_sessions (user_id,session_id,encrypted_tokens,updated_at) VALUES (?,?,?,?)"
    ).bind(userId, backendSid, encrypted, now),
    env.DB.prepare(
      "INSERT INTO workos_entitlements (user_id,organization_id,context,enabled,issued_at,expires_at,revision) VALUES (?,?,?,1,?,?,1)"
    ).bind(
      userId,
      personalOrganization,
      workosBillingConfiguration(env).context,
      now - 60_000,
      now - 1000
    ),
    env.DB.prepare(
      "INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,created_at,updated_at,device_name) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(
      desktopSessionId,
      "a".repeat(64),
      userId,
      "trial@example.test",
      "fixture_public_key",
      now,
      now,
      "Customer Mac"
    ),
  ])
  billingFailure = 503
  await assert.rejects(getAccountEntitlement(env, userId))
  const response = await api(undefined, `?history=1&userId=${userId}`)
  assert.equal(response.status, 200)
  const details = await response.json()
  assert.equal(details.accessUnavailable, true)
  assert.equal(details.user.accessUnavailable, true)
  assert.equal(details.access.canHost, false)
  assert.equal(details.access.canUseLocal, false)
  assert.equal(details.managed, null)
  assert.equal(details.subscription.id, grant.id)
  assert.equal(details.subscription.notes, "Historical support notes")
  assert.equal(details.audit.length, 1)
  assert.equal(details.devices[0].sessionId, desktopSessionId)
  assert.equal(details.user.devices[0].deviceName, "Customer Mac")

  const directory = await api()
  assert.equal(directory.status, 200)
  const directoryData = await directory.json()
  assert.equal(directoryData.users.length, 3)
  assert.equal(directoryData.users[0].accessUnavailable, true)
  assert.ok(
    directoryData.users.slice(1).every((user) => !user.accessUnavailable)
  )

  const removed = await api({
    action: "remove-device",
    userId,
    sessionId: desktopSessionId,
    expectedSessionRevision: 1,
    reason: "Customer requested removal during billing outage",
  })
  assert.equal(removed.status, 200)
  assert.deepEqual((await removed.json()).devices, [])
  const updated = await (
    await api(undefined, `?history=1&userId=${userId}`)
  ).json()
  assert.equal(updated.accessUnavailable, true)
  assert.equal(updated.devices[0].current, false)
  assert.equal(updated.deviceAudit.length, 1)
  assert.equal(await count("account_entitlements"), 0)
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT reauth_needed FROM workos_billing_sessions WHERE user_id=?"
      )
        .bind(userId)
        .first()
    ).reauth_needed,
    0
  )
})
