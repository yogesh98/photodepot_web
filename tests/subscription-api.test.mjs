import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { sealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAdminSubscriptions } from "../functions/api/admin/subscriptions.ts"
import { setSubscription } from "../lib/subscription-store.ts"

const origin = "https://photodepot.app"
const clientId = "client_subscription_api"
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
    if (url.href === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    if (url.pathname === "/user_management/authenticate") {
      const body = JSON.parse(options.body)
      assert.equal(body.grant_type, "refresh_token")
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
  listPageSize = 100
  await env.DB.batch(
    [
      "DELETE FROM account_devices",
      "DELETE FROM subscription_audit",
      "DELETE FROM subscriptions",
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
      ...["extend", "revoke", "restore", "reset-device"].map((action) =>
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
test("setting and extending subscriptions use exact day lengths and stable account identity", async () => {
  const created = await api(setBody())
  assert.equal(created.status, 201)
  let subscription = (await created.json()).subscription
  assert.equal(subscription.userId, "user_api_trial")
  assert.equal(subscription.type, "trial")
  assert.equal(subscription.status, "active")
  assert.equal(subscription.endsAt - subscription.startsAt, 14 * day)
  const id = subscription.id
  const edited = await api(
    setBody("user_api_trial", {
      type: "regular",
      durationDays: 365,
      expectedRevision: 1,
    })
  )
  subscription = (await edited.json()).subscription
  assert.equal(subscription.id, id)
  assert.equal(subscription.type, "regular")
  assert.equal(subscription.revision, 2)
  assert.equal(subscription.endsAt - subscription.startsAt, 365 * day)
  const previousEnd = subscription.endsAt
  const extended = await api({
    action: "extend",
    userId: "user_api_trial",
    durationDays: 7,
    expectedRevision: 2,
  })
  subscription = (await extended.json()).subscription
  assert.equal(subscription.type, "regular")
  assert.equal(subscription.endsAt, previousEnd + 7 * day)
  const page = await (await api()).json()
  assert.deepEqual(
    page.users.find((entry) => entry.id === "user_api_trial").subscription,
    subscription
  )
  const history = await (
    await api(undefined, "?userId=user_api_trial&history=1")
  ).json()
  assert.equal(history.audit.length, 3)
  assert.ok(history.audit.every((entry) => entry.actor === adminEmail))
})
test("revoked access stays revoked on extension and restoring an ended term keeps it expired", async () => {
  await api(setBody())
  const revoked = await (
    await api({
      action: "revoke",
      userId: "user_api_trial",
      expectedRevision: 1,
    })
  ).json()
  assert.equal(revoked.subscription.status, "revoked")
  const extended = await (
    await api({
      action: "extend",
      userId: "user_api_trial",
      durationDays: 7,
      expectedRevision: 2,
    })
  ).json()
  assert.equal(extended.subscription.status, "revoked")
  const restored = await (
    await api({
      action: "restore",
      userId: "user_api_trial",
      expectedRevision: 3,
    })
  ).json()
  assert.equal(restored.subscription.status, "active")
  const now = Date.now()
  await setSubscription(
    env.DB,
    {
      userId: "user_api_regular",
      type: "regular",
      expectedRevision: 0,
      endsAt: now - day,
    },
    adminEmail,
    now - 10 * day
  )
  await api({
    action: "revoke",
    userId: "user_api_regular",
    expectedRevision: 1,
  })
  const old = await (
    await api({
      action: "restore",
      userId: "user_api_regular",
      expectedRevision: 2,
    })
  ).json()
  assert.equal(old.subscription.status, "expired")
  const renewed = await (
    await api({
      action: "extend",
      userId: "user_api_regular",
      durationDays: 30,
      expectedRevision: 3,
    })
  ).json()
  assert.equal(renewed.subscription.status, "active")
  assert.ok(renewed.subscription.endsAt >= now + 30 * day)
})
test("stale revisions produce a conflict without changing subscription state or audit history", async () => {
  await api(setBody())
  const duplicate = await api(setBody())
  assert.equal(duplicate.status, 409)
  await api({ action: "revoke", userId: "user_api_trial", expectedRevision: 1 })
  const stale = await api(setBody("user_api_trial", { expectedRevision: 1 }))
  assert.equal(stale.status, 409)
  assert.equal(await count("subscription_audit"), 2)
  const record = await env.DB.prepare(
    "SELECT status, revision FROM subscriptions WHERE user_id = ?"
  )
    .bind("user_api_trial")
    .first()
  assert.deepEqual(record, { status: "revoked", revision: 2 })
})
test("mutations require an existing WorkOS user and fail closed during lookup outages", async () => {
  for (const action of ["set", "extend", "revoke", "restore", "reset-device"]) {
    const missing = await api({
      ...setBody("user_api_deleted"),
      action,
      expectedRevision: action === "set" ? 0 : 1,
    })
    assert.equal(missing.status, 404)
  }
  userFailure = 503
  assert.equal((await api(setBody())).status, 503)
  assert.equal(await count("subscriptions"), 0)
})
test("subscription mutations reject invalid fields, cross-origin requests and oversized JSON", async () => {
  for (const durationDays of [0, -1, 3651, 1.5, "30", null])
    assert.equal((await api(setBody(undefined, { durationDays }))).status, 400)
  for (const expectedRevision of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER])
    assert.equal(
      (await api(setBody(undefined, { expectedRevision }))).status,
      400
    )
  for (const values of [
    { type: "standard" },
    { type: "owner" },
    { action: "grant" },
    { userId: "invalid" },
  ])
    assert.equal((await api(setBody(undefined, values))).status, 400)
  assert.equal(
    (await api(setBody(), "", { origin: "https://attacker.example" })).status,
    403
  )
  assert.equal(
    (await api(setBody(), "", { "content-type": "text/plain" })).status,
    415
  )
  const suppliedCookie = await cookie()
  const large = new Request(`${origin}/api/admin/subscriptions`, {
    method: "POST",
    headers: {
      origin,
      cookie: suppliedCookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...setBody(), notes: "a".repeat(9000) }),
  })
  assert.equal((await handleAdminSubscriptions(large, env)).status, 413)
  const malformed = new Request(`${origin}/api/admin/subscriptions`, {
    method: "POST",
    headers: {
      origin,
      cookie: suppliedCookie,
      "content-type": "application/json",
    },
    body: "{",
  })
  assert.equal((await handleAdminSubscriptions(malformed, env)).status, 400)
  const unsupported = await handleAdminSubscriptions(
    request("", undefined, { cookie: suppliedCookie }, "PUT"),
    env
  )
  assert.equal(unsupported.status, 405)
  assert.equal(unsupported.headers.get("allow"), "GET, POST")
  assert.equal(userRequests.length, 0)
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
test("Mac reset retains prior identity proofs, expiry and type while advancing the binding revision", async () => {
  await api(setBody())
  const deviceId = "b".repeat(64)
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO account_devices (device_id, user_id, public_key, binding_revision, activated_at, active) VALUES (?, ?, ?, 1, ?, 1)"
    ).bind(deviceId, "user_api_trial", "fixture-public-key", Date.now()),
  ])
  const original = await env.DB.prepare(
    "SELECT type, end_at FROM subscriptions WHERE user_id = ?"
  )
    .bind("user_api_trial")
    .first()
  const response = await api({
    action: "reset-device",
    userId: "user_api_trial",
    expectedRevision: 1,
  })
  assert.equal(response.status, 200)
  const reset = (await response.json()).subscription
  assert.equal(reset.type, original.type)
  assert.equal(reset.endsAt, original.end_at)
  assert.equal(reset.revision, 2)
  const row = await env.DB.prepare(
    "SELECT binding_revision FROM subscriptions WHERE user_id = ?"
  )
    .bind("user_api_trial")
    .first()
  assert.deepEqual(row, { binding_revision: 2 })
  assert.equal(await count("account_devices"), 1)
  const history = await (
    await api(undefined, "?userId=user_api_trial&history=1")
  ).json()
  assert.ok(
    history.audit.some(
      (entry) => entry.action === "reset-device" && entry.actor === adminEmail
    )
  )
})
test("resetting a user without a subscription is a client conflict rather than a service outage", async () => {
  const response = await api({
    action: "reset-device",
    userId: "user_api_trial",
    expectedRevision: 0,
  })
  assert.equal(response.status, 400)
  assert.equal(await count("subscriptions"), 0)
})
test("refreshed Owner cookies propagate on successful reads and rejected mutations", async () => {
  for (const body of [undefined, setBody(undefined, { durationDays: 0 })]) {
    const response = await handleAdminSubscriptions(
      request("", body, { cookie: await cookie({ exp: 1 }) }),
      env
    )
    assert.equal(response.status, body ? 400 : 200)
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

test("dashboard overview counts the whole subscription database rather than the current WorkOS page", async (t) => {
  const now = Date.now()
  t.mock.method(Date, "now", () => now)
  listPageSize = 1
  await api(setBody("user_api_trial", { durationDays: 7 }))
  await api(setBody("user_api_regular", { type: "regular", durationDays: 30 }))
  await setSubscription(
    env.DB,
    {
      userId: "user_not_on_page",
      type: "trial",
      expectedRevision: 0,
      endsAt: now,
    },
    adminEmail,
    now - day
  )
  await setSubscription(
    env.DB,
    {
      userId: "user_other_hidden",
      type: "regular",
      expectedRevision: 0,
      endsAt: now + day,
    },
    adminEmail,
    now
  )
  await env.DB.prepare(
    "UPDATE subscriptions SET status = 'revoked' WHERE user_id = 'user_other_hidden'"
  ).run()
  const page = await (await api()).json()
  assert.equal(page.users.length, 1)
  assert.equal(page.nextCursor, "user_api_trial")
  assert.deepEqual(page.overview, {
    totalSubscriptions: 4,
    active: 2,
    activeTrials: 1,
    activeStandard: 1,
    expired: 1,
    revoked: 1,
    expiringSoon: 1,
    assignedMacs: 0,
    asOf: now,
    expiringWithinDays: 7,
  })
  assert.equal(page.environment, "production")
  assert.equal(page.billingMode, "manual")
  assert.equal(page.trialDays, 7)
  const development = await handleAdminSubscriptions(
    request("", undefined, { cookie: await cookie() }),
    { ...env, PHOTODEPOT_ENVIRONMENT: "development" }
  )
  assert.equal((await development.json()).environment, "development")
})

test("exact grant and extension dates, administrator notes and reasons are persisted with guarded audits", async (t) => {
  const now = Date.now()
  t.mock.method(Date, "now", () => now)
  const granted = await api({
    action: "set",
    userId: "user_api_trial",
    type: "trial",
    endsAt: now + 10 * day,
    expectedRevision: 0,
    notes: "  Manual customer grant  ",
    reason: "Approved by owner",
  })
  assert.equal(granted.status, 201)
  const original = (await granted.json()).subscription
  assert.equal(original.endsAt, now + 10 * day)
  assert.equal(original.notes, "Manual customer grant")
  const extended = await api({
    action: "extend",
    userId: "user_api_trial",
    endsAt: now + 20 * day,
    expectedRevision: 1,
    reason: "Support extension",
  })
  assert.equal(extended.status, 200)
  const extension = (await extended.json()).subscription
  assert.equal(extension.startsAt, original.startsAt)
  assert.equal(extension.endsAt, now + 20 * day)
  assert.equal(extension.notes, original.notes)
  const annotated = await api({
    action: "update-notes",
    userId: "user_api_trial",
    notes: "Support case 42",
    expectedRevision: 2,
    reason: "Internal account review",
  })
  assert.equal(annotated.status, 200)
  assert.equal((await annotated.json()).subscription.revision, 3)
  const history = await (
    await api(undefined, "?history=1&userId=user_api_trial")
  ).json()
  assert.equal(history.subscription.notes, "Support case 42")
  assert.deepEqual(history.devices, [])
  assert.equal(
    history.audit.find((entry) => entry.action === "set").reason,
    "Approved by owner"
  )
  assert.equal(
    history.audit.find((entry) => entry.action === "extend").reason,
    "Support extension"
  )
  assert.equal(
    history.audit.find((entry) => entry.action === "update-notes").reason,
    "Internal account review"
  )
  const shortened = await api({
    action: "extend",
    userId: "user_api_trial",
    endsAt: original.endsAt,
    expectedRevision: 3,
  })
  assert.equal(shortened.status, 400)
  const conflict = await api({
    action: "update-notes",
    userId: "user_api_trial",
    notes: "Stale client notes",
    expectedRevision: 2,
  })
  assert.equal(conflict.status, 409)
  assert.equal(await count("subscription_audit"), 3)
})

test("Mac assignment details exclude signing keys and reset reasons appear alongside historical assignments", async () => {
  await api(setBody())
  const deviceId = "d".repeat(64)
  const activatedAt = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active) VALUES (?,?,?,1,?,1)"
    ).bind(deviceId, "user_api_trial", "secret-signing-key", activatedAt),
  ])
  const page = await (await api()).json()
  assert.deepEqual(page.users[0].subscription.devices, [
    {
      id: deviceId,
      bindingRevision: 1,
      assignmentRevision: 1,
      activatedAt,
    },
  ])
  assert.equal(page.overview.assignedMacs, 1)
  const before = await (
    await api(undefined, "?history=1&userId=user_api_trial")
  ).json()
  assert.deepEqual(before.devices, [
    {
      id: deviceId,
      bindingRevision: 1,
      assignmentRevision: 1,
      activatedAt,
      current: true,
    },
  ])
  assert.equal(JSON.stringify(before).includes("secret-signing-key"), false)
  const reset = await api({
    action: "reset-device",
    userId: "user_api_trial",
    expectedRevision: 1,
    reason: "Customer replaced their Mac",
  })
  assert.equal(reset.status, 200)
  assert.deepEqual((await reset.json()).subscription.devices, [])
  const after = await (
    await api(undefined, "?history=1&userId=user_api_trial")
  ).json()
  assert.deepEqual(after.devices, [
    {
      id: deviceId,
      bindingRevision: 1,
      assignmentRevision: 1,
      activatedAt,
      current: false,
    },
  ])
  assert.equal(
    after.audit.find((entry) => entry.action === "reset-device").reason,
    "Customer replaced their Mac"
  )
})

test("invalid notes, reasons and exact expiry fields fail before contacting WorkOS or mutating access", async () => {
  const future = Date.now() + day
  for (const values of [
    { notes: 42 },
    { notes: null },
    { notes: "a".repeat(2001) },
    { reason: 42 },
    { reason: null },
    { reason: "a".repeat(1001) },
    { endsAt: future },
    { durationDays: undefined, endsAt: null },
    { durationDays: undefined, endsAt: "2030-01-01" },
    { durationDays: undefined, endsAt: Date.now() - 1 },
    { durationDays: undefined, endsAt: 8_640_000_000_000_001 },
    { action: "update-notes", notes: undefined, expectedRevision: 1 },
  ])
    assert.equal((await api(setBody(undefined, values))).status, 400)
  assert.equal(
    (await api(setBody(), "", { "content-type": "application/json-invalid" }))
      .status,
    415
  )
  assert.equal(userRequests.length, 0)
  assert.equal(await count("subscriptions"), 0)
  assert.equal(await count("subscription_audit"), 0)
})

test("targeted admin reset keeps the second Mac active and rejects an unknown or other account's assignment", async () => {
  await api(setBody())
  await api(setBody("user_api_regular", { type: "regular" }))
  const firstMac = "a".repeat(64),
    otherMac = "b".repeat(64),
    foreignMac = "c".repeat(64)
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active) VALUES (?,'user_api_trial','first-public-key',1,?,1)"
    ).bind(firstMac, now),
    env.DB.prepare(
      "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active) VALUES (?,'user_api_trial','other-public-key',1,?,1)"
    ).bind(otherMac, now),
    env.DB.prepare(
      "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active) VALUES (?,'user_api_regular','foreign-public-key',1,?,1)"
    ).bind(foreignMac, now),
  ])
  const original = (await (await api()).json()).users.find(
    (user) => user.id === "user_api_trial"
  ).subscription
  assert.equal(original.devices.length, 2)
  assert.equal(original.deviceLimit, 2)
  for (const deviceId of ["d".repeat(64), foreignMac]) {
    const rejected = await api({
      action: "reset-device",
      userId: "user_api_trial",
      expectedRevision: 1,
      deviceId,
    })
    assert.equal(rejected.status, 409)
  }
  assert.equal(await count("subscription_audit"), 2)
  const reset = await api({
    action: "reset-device",
    userId: "user_api_trial",
    expectedRevision: 1,
    deviceId: firstMac,
    reason: "Retired one Mac",
  })
  assert.equal(reset.status, 200)
  const changed = (await reset.json()).subscription
  assert.equal(changed.bindingRevision, original.bindingRevision)
  assert.equal(changed.revision, 2)
  assert.equal(changed.type, original.type)
  assert.equal(changed.endsAt, original.endsAt)
  assert.deepEqual(
    changed.devices.map(({ id }) => id),
    [otherMac]
  )
  const history = await (
    await api(undefined, "?history=1&userId=user_api_trial")
  ).json()
  assert.equal(history.devices.find(({ id }) => id === firstMac).current, false)
  assert.equal(
    history.devices.find(({ id }) => id === firstMac).assignmentRevision,
    2
  )
  assert.equal(history.devices.find(({ id }) => id === otherMac).current, true)
  assert.equal(
    history.audit.find(({ action }) => action === "reset-device").reason,
    "Retired one Mac"
  )
  const foreign = (await (await api()).json()).users.find(
    (user) => user.id === "user_api_regular"
  ).subscription
  assert.deepEqual(
    foreign.devices.map(({ id }) => id),
    [foreignMac]
  )
  const global = await api({
    action: "reset-device",
    userId: "user_api_trial",
    expectedRevision: 2,
  })
  assert.equal(global.status, 200)
  const allReset = (await global.json()).subscription
  assert.deepEqual(allReset.devices, [])
  assert.equal(allReset.bindingRevision, original.bindingRevision + 1)
})

test("admin device identifiers are validated before WorkOS lookup and only accepted for reset", async () => {
  for (const deviceId of [null, 123, "invalid", "a".repeat(63), "A".repeat(64)])
    assert.equal(
      (
        await api({
          action: "reset-device",
          userId: "user_api_trial",
          expectedRevision: 1,
          deviceId,
        })
      ).status,
      400
    )
  assert.equal(
    (await api(setBody(undefined, { deviceId: "a".repeat(64) }))).status,
    400
  )
  assert.equal(userRequests.length, 0)
  assert.equal(await count("subscription_audit"), 0)
})
