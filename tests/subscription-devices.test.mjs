import assert from "node:assert/strict"
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleLicenseRequest } from "../lib/license-api.ts"
import { LICENSE_GRACE_MS, signedReceipt } from "../lib/license-crypto.ts"
import { activateDevice, grantLicense } from "../lib/license-store.ts"
import { hashLicenseKey } from "../lib/license-crypto.ts"
import {
  bindSubscriptionDevice,
  getSubscriptionDevice,
  resetSubscriptionDevice,
} from "../lib/subscription-devices.ts"
import {
  changeSubscription,
  getSubscription,
  listSubscriptionAudit,
  setSubscription,
  SubscriptionConflictError,
} from "../lib/subscription-store.ts"

const vendor = generateKeyPairSync("ed25519")
const actor = "owner@example.com"
const origin = "https://photodepot.app"
const epoch = Date.now()
let platform, database, env, originalFetch, oldSubscription
let requestCount = 0
let sequence = 0
const users = new Map()

before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  database = platform.env.DB
  env = {
    ...platform.env,
    WORKOS_CLIENT_ID: "client_subscription_tests",
    WORKOS_API_KEY: "sk_test_subscription_tests",
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  }
  for (const filename of [
    "0001_waitlist.sql",
    "0002_licenses.sql",
    "0003_subscriptions.sql",
  ]) {
    const source = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8"
    )
    await database.batch(
      unstable_splitSqlQuery(source).map((sql) => database.prepare(sql))
    )
  }
  oldSubscription = await assign("user_before_device_migration")
  const source = await readFile(
    new URL("../migrations/0004_account_devices.sql", import.meta.url),
    "utf8"
  )
  await database.batch(
    unstable_splitSqlQuery(source).map((sql) => database.prepare(sql))
  )
  originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    requestCount++
    assert.match(
      String(url),
      /^https:\/\/api\.workos\.com\/user_management\/users\/user_[A-Za-z0-9_]+$/
    )
    assert.equal(
      new Headers(options.headers).get("authorization"),
      `Bearer ${env.WORKOS_API_KEY}`
    )
    const userId = new URL(url).pathname.split("/").at(-1)
    const user = users.get(userId)
    if (user === "unavailable")
      return Response.json({ message: "Service unavailable" }, { status: 503 })
    if (!user)
      return Response.json({ message: "User not found" }, { status: 404 })
    return Response.json({
      object: "user",
      id: userId,
      email: `${userId}@example.com`,
      email_verified: user.emailVerified,
      first_name: "Customer",
      last_name: "Tester",
      created_at: new Date(epoch).toISOString(),
      updated_at: new Date(epoch).toISOString(),
    })
  }
})

after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})

function device() {
  const pair = generateKeyPairSync("ed25519")
  const bytes = pair.publicKey.export({ format: "der", type: "spki" })
  return {
    ...pair,
    deviceId: createHash("sha256").update(bytes).digest("hex"),
    publicKeyEncoded: bytes.toString("base64url"),
  }
}

async function assign(userId, values = {}, now = epoch) {
  users.set(userId, { emailVerified: true })
  return setSubscription(
    database,
    {
      userId,
      type: "trial",
      endsAt: now + 7 * 24 * 60 * 60 * 1000,
      expectedRevision: 0,
      ...values,
    },
    actor,
    now
  )
}

function bind(userId, mac, now = epoch) {
  return bindSubscriptionDevice(
    database,
    { userId, deviceId: mac.deviceId, publicKey: mac.publicKeyEncoded },
    now
  )
}

function proof(mac) {
  const challenge = randomBytes(32).toString("base64url")
  return {
    deviceId: mac.deviceId,
    challenge,
    signature: sign(
      null,
      Buffer.from(
        JSON.stringify([
          "photodepot-license-v1",
          "verify",
          mac.deviceId,
          challenge,
        ])
      ),
      mac.privateKey
    ).toString("base64url"),
  }
}

function verifyRequest(mac, bindings = env, changes = {}) {
  return handleLicenseRequest(
    new Request(`${origin}/api/licenses/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `account-test-${sequence++}`,
      },
      body: JSON.stringify({ ...proof(mac), ...changes }),
    }),
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
  const payload = JSON.parse(bytes.toString("utf8"))
  assert.ok(payload.issuedAt < payload.expiresAt)
  assert.ok(payload.expiresAt - payload.issuedAt <= LICENSE_GRACE_MS)
  assert.equal("userId" in payload, false)
  assert.equal("email" in payload, false)
  return payload
}

test("account device migration preserves subscriptions and grants no Mac assignment", async () => {
  assert.deepEqual(
    await getSubscription(database, oldSubscription.userId, epoch),
    oldSubscription
  )
  const row = await database
    .prepare(
      "SELECT current_device_id, binding_revision FROM subscriptions WHERE user_id = ?"
    )
    .bind(oldSubscription.userId)
    .first()
  assert.deepEqual(row, { current_device_id: null, binding_revision: 1 })
  assert.equal(
    (
      await database
        .prepare("SELECT count(*) AS count FROM account_devices")
        .first()
    ).count,
    0
  )
  assert.equal(
    (await listSubscriptionAudit(database, oldSubscription.userId)).length,
    1
  )
})

test("concurrent Mac sign-ins claim one slot, while reconnecting the same Mac is idempotent", async () => {
  const userId = "user_one_mac"
  const subscription = await assign(userId)
  const macs = Array.from({ length: 6 }, device)
  const results = await Promise.all(macs.map((mac) => bind(userId, mac)))
  assert.equal(results.filter(Boolean).length, 1)
  const index = results.findIndex(Boolean)
  const current = results[index]
  assert.equal(current.userId, userId)
  assert.equal(current.publicKey, macs[index].publicKeyEncoded)
  assert.equal(current.currentDeviceId, macs[index].deviceId)
  assert.equal(current.bindingRevision, current.currentBindingRevision)
  assert.equal(current.subscription.id, subscription.id)
  assert.equal(current.subscription.revision, 2)
  assert.deepEqual(await bind(userId, macs[index], epoch + 100), current)
  assert.equal((await listSubscriptionAudit(database, userId)).length, 2)
  assert.equal(
    await bindSubscriptionDevice(
      database,
      {
        userId,
        deviceId: macs[index].deviceId,
        publicKey: macs[index].publicKeyEncoded,
        expectedBindingRevision: current.currentBindingRevision + 1,
      },
      epoch + 200
    ),
    null
  )
  assert.deepEqual(
    await getSubscriptionDevice(database, macs[index].deviceId, epoch),
    current
  )
  assert.equal((await listSubscriptionAudit(database, userId)).length, 2)
  for (const [other, mac] of macs.entries())
    if (other !== index)
      assert.equal(
        await getSubscriptionDevice(database, mac.deviceId, epoch),
        null
      )
})

test("a Mac cannot silently move between accounts, including after the old account resets it", async () => {
  const firstUser = "user_mac_owner"
  const otherUser = "user_mac_other"
  await assign(firstUser)
  await assign(otherUser)
  const mac = device()
  await bind(firstUser, mac)
  assert.equal(await bind(otherUser, mac), null)
  await resetSubscriptionDevice(database, firstUser, 2, actor, epoch + 100)
  assert.equal(await bind(otherUser, mac, epoch + 200), null)
  assert.equal(
    (await getSubscriptionDevice(database, mac.deviceId, epoch + 200)).userId,
    firstUser
  )
  assert.equal((await getSubscription(database, otherUser, epoch)).revision, 1)
  assert.equal((await listSubscriptionAudit(database, otherUser)).length, 1)
})

test("device reset rejects stale revisions and retains prior keys so replacement cannot revive the old Mac", async () => {
  const userId = "user_reset"
  await assign(userId)
  const oldMac = device()
  const newMac = device()
  const first = await bind(userId, oldMac, epoch + 1)
  await assert.rejects(
    resetSubscriptionDevice(database, userId, 1, actor, epoch + 100),
    SubscriptionConflictError
  )
  assert.equal((await listSubscriptionAudit(database, userId)).length, 2)
  const reset = await resetSubscriptionDevice(
    database,
    userId,
    2,
    actor,
    epoch + 100
  )
  assert.equal(reset.revision, 3)
  const old = await getSubscriptionDevice(
    database,
    oldMac.deviceId,
    epoch + 100
  )
  assert.equal(old.currentDeviceId, null)
  assert.equal(old.publicKey, oldMac.publicKeyEncoded)
  assert.ok(old.bindingRevision < old.currentBindingRevision)
  const replacement = await bind(userId, newMac, epoch + 200)
  assert.equal(replacement.subscription.revision, 4)
  assert.equal(replacement.currentDeviceId, newMac.deviceId)
  assert.equal(await bind(userId, oldMac, epoch + 300), null)
  assert.equal(
    (await getSubscriptionDevice(database, oldMac.deviceId, epoch + 300))
      .currentDeviceId,
    newMac.deviceId
  )
  assert.equal(first.subscription.id, replacement.subscription.id)
  assert.deepEqual(
    (await listSubscriptionAudit(database, userId)).map(({ action }) => action),
    ["bind-device", "reset-device", "bind-device", "set"]
  )
  assert.equal(
    (await listSubscriptionAudit(database, userId)).filter(
      ({ action }) => action === "reset-device"
    ).length,
    1
  )
})

test("missing, expired and revoked subscriptions cannot bind devices, and mismatched keys cannot change storage", async () => {
  const mac = device()
  assert.equal(await bind("user_no_subscription", mac), null)
  await assign("user_expired_binding", { endsAt: epoch + 100 })
  assert.equal(await bind("user_expired_binding", mac, epoch + 100), null)
  await assign("user_revoked_binding")
  await changeSubscription(
    database,
    "user_revoked_binding",
    "revoke",
    1,
    actor,
    undefined,
    epoch
  )
  assert.equal(await bind("user_revoked_binding", mac), null)
  await assign("user_invalid_binding")
  await assert.rejects(
    bindSubscriptionDevice(
      database,
      {
        userId: "user_invalid_binding",
        deviceId: mac.deviceId,
        publicKey: device().publicKeyEncoded,
      },
      epoch
    ),
    /Invalid device/
  )
  assert.equal(await getSubscriptionDevice(database, mac.deviceId, epoch), null)
  assert.equal(
    (await getSubscription(database, "user_invalid_binding", epoch)).revision,
    1
  )
})

test("failed device audit writes roll back assignments and resets", async () => {
  const userId = "user_device_atomic"
  await assign(userId)
  const mac = device()
  await database
    .prepare(
      `CREATE TRIGGER reject_device_bind_audit BEFORE INSERT ON subscription_audit
    WHEN NEW.action = 'bind-device' BEGIN SELECT RAISE(ABORT, 'device audit unavailable'); END`
    )
    .run()
  try {
    await assert.rejects(bind(userId, mac), /device audit unavailable/)
    assert.equal(
      await getSubscriptionDevice(database, mac.deviceId, epoch),
      null
    )
    assert.equal((await getSubscription(database, userId, epoch)).revision, 1)
  } finally {
    await database.prepare("DROP TRIGGER reject_device_bind_audit").run()
  }
  const bound = await bind(userId, mac)
  await database
    .prepare(
      `CREATE TRIGGER reject_device_reset_audit BEFORE INSERT ON subscription_audit
    WHEN NEW.action = 'reset-device' BEGIN SELECT RAISE(ABORT, 'device audit unavailable'); END`
    )
    .run()
  try {
    await assert.rejects(
      resetSubscriptionDevice(database, userId, 2, actor, epoch + 100),
      /device audit unavailable/
    )
    assert.deepEqual(
      await getSubscriptionDevice(database, mac.deviceId, epoch),
      bound
    )
    assert.equal((await listSubscriptionAudit(database, userId)).length, 2)
  } finally {
    await database.prepare("DROP TRIGGER reject_device_reset_audit").run()
  }
})

test("active account receipts cap offline access at subscription expiration and verify the live WorkOS user", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_active_receipt"
  const subscription = await assign(userId, {
    endsAt: epoch + 30 * 60 * 1000,
    type: "regular",
  })
  const mac = device()
  await bind(userId, mac)
  const requestsBefore = requestCount
  const payload = await receipt(await verifyRequest(mac))
  assert.equal(payload.status, "active")
  assert.equal(payload.type, "regular")
  assert.equal(payload.licenseId, subscription.id)
  assert.equal(payload.deviceId, mac.deviceId)
  assert.equal(payload.expiresAt, subscription.endsAt)
  assert.equal(payload.revision, 2)
  assert.equal(requestCount, requestsBefore + 1)
  const longUser = "user_long_receipt"
  await assign(longUser)
  const otherMac = device()
  await bind(longUser, otherMac)
  const long = await receipt(await verifyRequest(otherMac))
  assert.equal(long.expiresAt - long.issuedAt, LICENSE_GRACE_MS)
})

test("subscription expiry, revocation, reset, unverified email and deleted WorkOS accounts produce valid revoked receipts", async (t) => {
  let currentTime = epoch
  t.mock.method(Date, "now", () => currentTime)
  for (const reason of [
    "expired",
    "revoked",
    "reset",
    "unverified",
    "deleted",
  ]) {
    const userId = `user_receipt_${reason}`
    const subscription = await assign(userId, { endsAt: epoch + 100 })
    const mac = device()
    await bind(userId, mac)
    if (reason === "expired") {
      const payload = signedReceipt(
        vendor.privateKey,
        {
          licenseId: subscription.id,
          deviceId: mac.deviceId,
          type: "trial",
          status: "revoked",
          challenge: proof(mac).challenge,
          revision: 2,
        },
        epoch + 100,
        epoch + 100
      )
      assert.equal(
        JSON.parse(Buffer.from(payload.payload, "base64url")).expiresAt,
        epoch + 100 + LICENSE_GRACE_MS
      )
      currentTime = epoch + 100
    } else if (reason === "revoked")
      await changeSubscription(
        database,
        userId,
        "revoke",
        2,
        actor,
        undefined,
        epoch
      )
    else if (reason === "reset")
      await resetSubscriptionDevice(database, userId, 2, actor, epoch)
    else if (reason === "unverified")
      users.set(userId, { emailVerified: false })
    else users.delete(userId)
    const payload = await receipt(await verifyRequest(mac))
    assert.equal(payload.status, "revoked")
    assert.equal(payload.licenseId, subscription.id)
    assert.equal(payload.expiresAt - payload.issuedAt, LICENSE_GRACE_MS)
    currentTime = epoch
  }
})

test("account verification fails closed on WorkOS outages, missing credentials and forged device proofs", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_unavailable_verification"
  await assign(userId)
  const mac = device()
  await bind(userId, mac)
  const countBefore = requestCount
  assert.equal(
    (await verifyRequest(mac, env, { signature: proof(device()).signature }))
      .status,
    401
  )
  assert.equal(requestCount, countBefore)
  assert.equal(
    (await verifyRequest(mac, { ...env, WORKOS_API_KEY: "" })).status,
    503
  )
  assert.equal(requestCount, countBefore)
  users.set(userId, "unavailable")
  const response = await verifyRequest(mac)
  assert.equal(response.status, 503)
  assert.equal("payload" in (await response.json()), false)
})

test("a bound subscription remains authoritative over an active legacy key after reset or account deletion", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const mac = device()
  const legacy = await grantLicense(
    database,
    {
      type: "regular",
      customerName: "Legacy Customer",
      email: "legacy@example.com",
      notes: "",
    },
    actor,
    epoch
  )
  await activateDevice(
    database,
    hashLicenseKey(legacy.key),
    mac.deviceId,
    mac.publicKeyEncoded,
    epoch
  )
  const original = await receipt(
    await verifyRequest(mac, { ...env, WORKOS_API_KEY: "" })
  )
  assert.equal(original.licenseId, legacy.license.id)
  assert.equal(original.status, "active")
  const userId = "user_legacy_bridge"
  const subscription = await assign(userId)
  await bind(userId, mac)
  await resetSubscriptionDevice(database, userId, 2, actor, epoch)
  const reset = await receipt(await verifyRequest(mac))
  assert.equal(reset.licenseId, subscription.id)
  assert.equal(reset.status, "revoked")
  users.delete(userId)
  const deleted = await receipt(await verifyRequest(mac))
  assert.equal(deleted.status, "revoked")
  assert.equal(deleted.licenseId, subscription.id)
})

test("a subscription-bound Mac cannot activate a legacy license key, including after its assignment is reset", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const accountMac = device()
  const userId = "user_no_legacy_activation"
  await assign(userId)
  await bind(userId, accountMac)
  const legacy = await grantLicense(
    database,
    {
      type: "regular",
      customerName: "Legacy Customer",
      email: "legacy@example.com",
      notes: "",
    },
    actor,
    epoch
  )
  const challenge = randomBytes(32).toString("base64url")
  const body = {
    key: legacy.key,
    devicePublicKey: accountMac.publicKeyEncoded,
    challenge,
    signature: sign(
      null,
      Buffer.from(
        JSON.stringify([
          "photodepot-license-v1",
          "activate",
          legacy.key,
          accountMac.publicKeyEncoded,
          challenge,
        ])
      ),
      accountMac.privateKey
    ).toString("base64url"),
  }
  const activate = () =>
    handleLicenseRequest(
      new Request(`${origin}/api/licenses/activate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `account-test-${sequence++}`,
        },
        body: JSON.stringify(body),
      }),
      env,
      "activate"
    )
  assert.equal((await activate()).status, 409)
  await resetSubscriptionDevice(database, userId, 2, actor, epoch)
  assert.equal((await activate()).status, 409)
  const unchanged = await database
    .prepare("SELECT current_device_id, revision FROM licenses WHERE id = ?")
    .bind(legacy.license.id)
    .first()
  assert.deepEqual(unchanged, { current_device_id: null, revision: 1 })
  assert.equal(
    await database
      .prepare("SELECT * FROM license_devices WHERE device_id = ?")
      .bind(accountMac.deviceId)
      .first(),
    null
  )
})
