import assert from "node:assert/strict"
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { sealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAccountSubscription } from "../functions/api/account/subscription.ts"
import { handleAdminSubscriptionRequests } from "../functions/api/admin/subscription-requests.ts"
import {
  bindSubscriptionDevice,
  getSubscriptionDevice,
} from "../lib/subscription-devices.ts"
import {
  getSubscription,
  listSubscriptionAudit,
  setSubscription,
} from "../lib/subscription-store.ts"
import { handleLicenseRequest } from "../lib/license-api.ts"
import {
  handleAccountApproval,
  handleAccountPairing,
} from "../lib/account-pairing.ts"
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
function device(pair = generateKeyPairSync("ed25519")) {
  const bytes = pair.publicKey.export({ format: "der", type: "spki" })
  return {
    ...pair,
    deviceId: createHash("sha256").update(bytes).digest("hex"),
    publicKeyEncoded: bytes.toString("base64url"),
    challenge: randomBytes(32).toString("base64url"),
  }
}
function pairing(device, action = "start", pairingId) {
  const parts =
    action === "start"
      ? [
          "photodepot-account-pairing-v1",
          action,
          device.deviceId,
          device.publicKeyEncoded,
          device.challenge,
        ]
      : [
          "photodepot-account-pairing-v1",
          action,
          pairingId,
          device.deviceId,
          device.challenge,
        ]
  return handleAccountPairing(
    new Request(`${origin}/api/account/pairing/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: device.deviceId,
        challenge: device.challenge,
        ...(action === "start"
          ? { devicePublicKey: device.publicKeyEncoded }
          : { pairingId }),
        deviceSignature: sign(
          null,
          Buffer.from(JSON.stringify(parts)),
          device.privateKey
        ).toString("base64url"),
      }),
    }),
    env,
    action
  )
}
async function approvePairing(device, auth) {
  const started = await pairing(device)
  assert.equal(started.status, 201)
  const value = await started.json()
  const approved = await handleAccountApproval(
    new Request(value.approvalUrl, {
      method: "POST",
      headers: { cookie: auth, origin },
    }),
    env
  )
  assert.equal(approved.status, 200)
  return value
}
async function verifyMac(device, version = "3", bindings = env) {
  const challenge = randomBytes(32).toString("base64url")
  const response = await handleLicenseRequest(
    new Request(`${origin}/api/licenses/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Photodepot-Receipt-Version": version,
      },
      body: JSON.stringify({
        deviceId: device.deviceId,
        challenge,
        signature: sign(
          null,
          Buffer.from(
            JSON.stringify([
              "photodepot-license-v1",
              "verify",
              device.deviceId,
              challenge,
            ])
          ),
          device.privateKey
        ).toString("base64url"),
      }),
    }),
    bindings,
    "verify"
  )
  assert.equal(response.status, 200)
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
  return { envelope, payload: JSON.parse(bytes.toString("utf8")) }
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
      "DELETE FROM subscription_request_audit",
      "DELETE FROM subscription_requests",
      "DELETE FROM account_pairings",
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
  assert.equal(account.subscription.deviceLimit, 2)
  assert.deepEqual(
    account.subscription.devices.map((device) => device.id),
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

test("request writes enforce own-device membership, CSRF, body and text limits", async () => {
  const auth = await cookie()
  for (const body of [
    { action: "request-device-reset", deviceId: "f".repeat(64) },
    { action: "request-device-reset", deviceId },
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

test("customers remove only the selected Mac immediately and retain their other Mac and subscription", async () => {
  const auth = await cookie()
  const otherMac = device()
  await bindSubscriptionDevice(env.DB, {
    userId: "user_dashboard_customer",
    deviceId: otherMac.deviceId,
    publicKey: otherMac.publicKeyEncoded,
  })
  const original = await getSubscription(env.DB, "user_dashboard_customer")
  const unchangedMac = await getSubscriptionDevice(env.DB, otherMac.deviceId)
  const unrelatedAccount = await getSubscription(env.DB, "user_dashboard_other")
  const response = await handleAccountSubscription(
    request("/api/account/subscription", auth, {
      action: "remove-device",
      deviceId,
      expectedRevision: original.revision,
    }),
    env
  )
  assert.equal(response.status, 200)
  const removed = (await response.json()).subscription
  assert.equal(removed.status, "active")
  assert.equal(removed.type, original.type)
  assert.equal(removed.endsAt, original.endsAt)
  assert.equal(removed.cancelAtPeriodEnd, original.cancelAtPeriodEnd)
  assert.equal(removed.revision, original.revision + 1)
  assert.deepEqual(removed.devices, [
    {
      id: otherMac.deviceId,
      activatedAt: unchangedMac.subscription.devices.find(
        ({ id }) => id === otherMac.deviceId
      ).activatedAt,
    },
  ])
  assert.equal("bindingRevision" in removed, false)
  assert.equal("notes" in removed, false)
  const revoked = await getSubscriptionDevice(env.DB, deviceId)
  assert.equal(revoked.active, false)
  assert.equal(revoked.assignmentRevision, 2)
  assert.equal(revoked.publicKey, publicKey)
  assert.equal(revoked.currentBindingRevision, original.bindingRevision)
  const currentMac = await getSubscriptionDevice(env.DB, otherMac.deviceId)
  assert.deepEqual(
    { ...currentMac, subscription: undefined },
    { ...unchangedMac, subscription: undefined }
  )
  assert.deepEqual(
    await getSubscription(env.DB, "user_dashboard_other"),
    unrelatedAccount
  )
  const audit = (
    await listSubscriptionAudit(env.DB, "user_dashboard_customer")
  ).find(({ action }) => action === "reset-device")
  assert.equal(audit.actor, "user_dashboard_customer@example.test")
  assert.equal(audit.reason, "Customer self-service Mac removal")
  assert.ok(audit.detail.includes(deviceId))
  const account = await (
    await handleAccountSubscription(
      request("/api/account/subscription", auth),
      env
    )
  ).json()
  assert.deepEqual(account.requests, [])

  // The retained signing identity delivers a definitive revocation even if
  // WorkOS is unavailable, rather than extending the old cached receipt.
  liveUsers.set("user_dashboard_customer", "unavailable")
  const lookups = accountLookups.length
  const { envelope, payload } = await verifyMac(device(mac))
  assert.equal(accountLookups.length, lookups)
  assert.equal(payload.status, "revoked")
  assert.equal(payload.revocationReason, "device-removed")
  assert.equal(payload.revision, removed.revision)
  assert.equal(payload.subscriptionEndsAt, original.endsAt)
  const compatibleBytes = Buffer.from(
    envelope.collaborationReceipt.payload,
    "base64url"
  )
  assert.ok(
    verify(
      null,
      compatibleBytes,
      vendor.publicKey,
      Buffer.from(envelope.collaborationReceipt.signature, "base64url")
    )
  )
  const compatible = JSON.parse(compatibleBytes.toString("utf8"))
  assert.equal("revocationReason" in compatible, false)
  assert.equal("subscriptionEndsAt" in compatible, false)
  assert.equal(compatible.status, "revoked")
  for (const version of ["1", "2"]) {
    const legacy = (await verifyMac(device(mac), version)).payload
    assert.equal(legacy.status, "revoked")
    assert.equal("revocationReason" in legacy, false)
  }
  liveUsers.set("user_dashboard_customer", {
    email: "customer@example.test",
    emailVerified: true,
  })
  assert.equal((await verifyMac(otherMac)).payload.status, "active")
  assert.equal("revocationReason" in (await verifyMac(otherMac)).payload, false)
})

test("Mac removal requires a current owned device and revision, rejects cross-origin writes and never removes all Macs", async () => {
  const auth = await cookie()
  const foreignMac = device()
  await bindSubscriptionDevice(env.DB, {
    userId: "user_dashboard_other",
    deviceId: foreignMac.deviceId,
    publicKey: foreignMac.publicKeyEncoded,
  })
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  const other = await getSubscription(env.DB, "user_dashboard_other")
  const body = {
    action: "remove-device",
    deviceId,
    expectedRevision: before.revision,
  }
  for (const values of [
    { deviceId: undefined },
    { deviceId: foreignMac.deviceId },
    { deviceId: "f".repeat(64) },
    { deviceId: null },
    { deviceId: [] },
    { expectedRevision: undefined },
    { expectedRevision: 0 },
    { expectedRevision: "2" },
    { expectedRevision: 1.5 },
    { userId: "user_dashboard_other" },
    { message: "Remove all my Macs" },
    { action: "request-device-reset" },
  ]) {
    const rejected = await handleAccountSubscription(
      request("/api/account/subscription", auth, { ...body, ...values }),
      env
    )
    assert.equal(rejected.status, 400)
  }
  assert.equal(
    (
      await handleAccountSubscription(
        request("/api/account/subscription", auth, body, {
          origin: "https://attacker.example",
        }),
        env
      )
    ).status,
    403
  )
  assert.equal(
    (
      await handleAccountSubscription(
        request("/api/account/subscription", auth, body, {
          "content-type": "text/plain",
        }),
        env
      )
    ).status,
    415
  )
  assert.deepEqual(
    await getSubscription(env.DB, "user_dashboard_customer"),
    before
  )
  assert.deepEqual(await getSubscription(env.DB, "user_dashboard_other"), other)
  assert.equal(
    (await listSubscriptionAudit(env.DB, "user_dashboard_customer")).length,
    2
  )
})

test("concurrent Mac removals win one revision and preserve the other assignment", async () => {
  const auth = await cookie()
  const otherMac = device()
  await bindSubscriptionDevice(env.DB, {
    userId: "user_dashboard_customer",
    deviceId: otherMac.deviceId,
    publicKey: otherMac.publicKeyEncoded,
  })
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  const results = await Promise.all(
    [deviceId, otherMac.deviceId].map((selected) =>
      handleAccountSubscription(
        request("/api/account/subscription", auth, {
          action: "remove-device",
          deviceId: selected,
          expectedRevision: before.revision,
        }),
        env
      )
    )
  )
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409])
  const current = await getSubscription(env.DB, "user_dashboard_customer")
  assert.equal(current.revision, before.revision + 1)
  assert.equal(current.devices.length, 1)
  assert.equal(
    (await listSubscriptionAudit(env.DB, "user_dashboard_customer")).filter(
      ({ action }) => action === "reset-device"
    ).length,
    1
  )
})

test("removal invalidates old sign-in approvals and a stale removal cannot revoke a newly paired assignment", async () => {
  const auth = await cookie()
  liveUsers.set("user_dashboard_customer", {
    email: "customer@example.test",
    emailVerified: true,
  })
  const selected = device(mac)
  const oldPairing = await approvePairing(selected, auth)
  assert.equal(
    (await pairing(selected, "poll", oldPairing.pairingId)).status,
    200
  )
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  const removal = {
    action: "remove-device",
    deviceId,
    expectedRevision: before.revision,
  }
  assert.equal(
    (
      await handleAccountSubscription(
        request("/api/account/subscription", auth, removal),
        env
      )
    ).status,
    200
  )
  assert.equal(
    (await pairing(selected, "poll", oldPairing.pairingId)).status,
    409
  )
  assert.equal(
    await bindSubscriptionDevice(env.DB, {
      userId: "user_dashboard_customer",
      deviceId,
      publicKey,
    }),
    null
  )
  const freshMac = device(mac)
  const freshPairing = await approvePairing(freshMac, auth)
  assert.equal(
    (await pairing(freshMac, "poll", freshPairing.pairingId)).status,
    200
  )
  const rebound = await getSubscriptionDevice(env.DB, deviceId)
  assert.equal(rebound.active, true)
  assert.equal(rebound.assignmentRevision, 2)
  const staleRemoval = await handleAccountSubscription(
    request("/api/account/subscription", auth, removal),
    env
  )
  assert.equal(staleRemoval.status, 409)
  assert.deepEqual(await getSubscriptionDevice(env.DB, deviceId), rebound)
  assert.equal((await verifyMac(freshMac)).payload.status, "active")
})

test("verification observes a fresh browser rebind after reading an inactive assignment and verifies the live user", async () => {
  const auth = await cookie()
  liveUsers.set("user_dashboard_customer", {
    email: "customer@example.test",
    emailVerified: true,
  })
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  assert.equal(
    (
      await handleAccountSubscription(
        request("/api/account/subscription", auth, {
          action: "remove-device",
          deviceId,
          expectedRevision: before.revision,
        }),
        env
      )
    ).status,
    200
  )
  const reconnecting = device(mac)
  let reads = 0
  let lookupsBeforeReceipt
  const bindings = {
    ...env,
    DB: {
      batch: (statements) => env.DB.batch(statements),
      prepare(sql) {
        const statement = env.DB.prepare(sql)
        if (!sql.includes("d.active AS device_active")) return statement
        return {
          bind(...values) {
            const bound = statement.bind(...values)
            return {
              async first() {
                const row = await bound.first()
                if (++reads === 1) {
                  assert.equal(row.device_active, 0)
                  const approval = await approvePairing(reconnecting, auth)
                  assert.equal(
                    (await pairing(reconnecting, "poll", approval.pairingId))
                      .status,
                    200
                  )
                  lookupsBeforeReceipt = accountLookups.length
                }
                return row
              },
            }
          },
        }
      },
    },
  }
  const { payload } = await verifyMac(reconnecting, "3", bindings)
  assert.equal(reads, 3)
  assert.equal(accountLookups.length, lookupsBeforeReceipt + 1)
  assert.equal(payload.status, "active")
  assert.equal("revocationReason" in payload, false)
  assert.equal(
    payload.revision,
    (await getSubscription(env.DB, "user_dashboard_customer")).revision
  )
})

test("a removal during a failed WorkOS lookup still produces signed immediate revocation", async () => {
  const auth = await cookie()
  const before = await getSubscription(env.DB, "user_dashboard_customer")
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    if (
      String(args[0]) ===
      `https://api.workos.com/user_management/users/user_dashboard_customer`
    ) {
      assert.equal(
        (
          await handleAccountSubscription(
            request("/api/account/subscription", auth, {
              action: "remove-device",
              deviceId,
              expectedRevision: before.revision,
            }),
            env
          )
        ).status,
        200
      )
      return Response.json({ message: "Unavailable" }, { status: 503 })
    }
    return savedFetch(...args)
  }
  try {
    const { payload } = await verifyMac(device(mac))
    assert.equal(payload.status, "revoked")
    assert.equal(payload.revocationReason, "device-removed")
    assert.equal(payload.revision, before.revision + 1)
  } finally {
    globalThis.fetch = savedFetch
  }
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

test("customers can cancel and resume only their own renewal, preserve access and reject stale or cross-origin changes", async () => {
  const auth = await cookie()
  const original = await getSubscription(env.DB, "user_dashboard_customer")
  const other = await getSubscription(env.DB, "user_dashboard_other")
  const body = { action: "cancel-renewal", expectedRevision: original.revision }
  for (const [changes, supplied, status] of [
    [{ origin: "https://attacker.example" }, body, 403],
    [{}, { ...body, userId: "user_dashboard_other" }, 400],
    [{}, { ...body, expectedRevision: 0 }, 400],
    [{}, { ...body, expectedRevision: undefined }, 400],
  ]) {
    const response = await handleAccountSubscription(
      request("/api/account/subscription", auth, supplied, changes),
      env
    )
    assert.equal(response.status, status)
  }
  const response = await handleAccountSubscription(
    request("/api/account/subscription", auth, body),
    env
  )
  assert.equal(response.status, 200)
  const canceled = (await response.json()).subscription
  assert.equal(canceled.status, "active")
  assert.equal(canceled.cancelAtPeriodEnd, true)
  assert.equal(canceled.endsAt, original.endsAt)
  assert.equal(canceled.revision, original.revision + 1)
  assert.equal(canceled.devices[0].id, original.devices[0].id)
  assert.equal("notes" in canceled, false)
  assert.deepEqual(await getSubscription(env.DB, "user_dashboard_other"), other)
  const stale = await handleAccountSubscription(
    request("/api/account/subscription", auth, {
      action: "resume-renewal",
      expectedRevision: original.revision,
    }),
    env
  )
  assert.equal(stale.status, 409)
  const blockedRequest = await handleAccountSubscription(
    request("/api/account/subscription", auth, { action: "request-renewal" }),
    env
  )
  assert.equal(blockedRequest.status, 400)
  const resumed = await handleAccountSubscription(
    request("/api/account/subscription", auth, {
      action: "resume-renewal",
      expectedRevision: canceled.revision,
    }),
    env
  )
  assert.equal(resumed.status, 200)
  const summary = (await resumed.json()).subscription
  assert.equal(summary.cancelAtPeriodEnd, false)
  assert.equal(summary.canceledAt, null)
  assert.equal(summary.endsAt, original.endsAt)
})

test("an expired canceled term can request a new renewal without silently restarting access", async () => {
  const auth = await cookie()
  const subscription = await getSubscription(env.DB, "user_dashboard_customer")
  await handleAccountSubscription(
    request("/api/account/subscription", auth, {
      action: "cancel-renewal",
      expectedRevision: subscription.revision,
    }),
    env
  )
  const now = Date.now()
  await env.DB.prepare(
    "UPDATE subscriptions SET started_at=?,end_at=? WHERE user_id=?"
  )
    .bind(now - 86_400_000, now - 1, "user_dashboard_customer")
    .run()
  const response = await handleAccountSubscription(
    request("/api/account/subscription", auth, {
      action: "request-renewal",
      message: "I would like a new term.",
    }),
    env
  )
  assert.equal(response.status, 201)
  assert.equal((await response.json()).request.action, "renewal")
  const ended = await getSubscription(env.DB, "user_dashboard_customer")
  assert.equal(ended.status, "expired")
  assert.equal(ended.cancelAtPeriodEnd, true)
  assert.equal(ended.endsAt, now - 1)
})
