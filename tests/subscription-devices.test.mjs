import assert from "node:assert/strict"
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
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
  listSubscriptionDevices,
  resetSubscriptionDevice,
} from "../lib/subscription-devices.ts"
import { revokeDesktopSession } from "../lib/account-sessions.ts"
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
const migratedMac = device(),
  migratedPreviousMac = device()
const migratedUserId = "user_before_two_mac_migration"

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
  // Seed the prior schema directly, then verify the new migration retains it.
  await database.batch([
    database
      .prepare(
        "INSERT INTO subscriptions (id,user_id,type,status,started_at,end_at,updated_at,revision) VALUES ('subscription-before-migration','user_before_device_migration','trial','active',?,?,?,1)"
      )
      .bind(epoch, epoch + 30 * 86_400_000, epoch),
    database
      .prepare(
        "INSERT INTO subscription_audit (id,subscription_id,action,actor,created_at,detail) VALUES ('audit-before-migration','subscription-before-migration','set',?,?,'Existing trial')"
      )
      .bind(actor, epoch),
  ])
  const source = await readFile(
    new URL("../migrations/0004_account_devices.sql", import.meta.url),
    "utf8"
  )
  await database.batch(
    unstable_splitSqlQuery(source).map((sql) => database.prepare(sql))
  )
  for (const filename of [
    "0005_account_pairings.sql",
    "0006_subscription_management.sql",
    "0007_two_mac_assignments.sql",
    "0011_desktop_account_sessions.sql",
    "0012_desktop_device_metadata.sql",
  ]) {
    if (filename === "0007_two_mac_assignments.sql") {
      await database.batch([
        database
          .prepare(
            "INSERT INTO subscriptions (id,user_id,type,status,started_at,end_at,updated_at,revision,binding_revision,current_device_id,notes) VALUES ('before-two-mac-migration',?,'regular','active',?,?,?,7,4,?,'Retained notes')"
          )
          .bind(
            migratedUserId,
            epoch,
            epoch + 86_400_000,
            epoch,
            migratedMac.deviceId
          ),
        database
          .prepare(
            "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at) VALUES (?,?,?,4,?)"
          )
          .bind(
            migratedMac.deviceId,
            migratedUserId,
            migratedMac.publicKeyEncoded,
            epoch
          ),
        database
          .prepare(
            "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at) VALUES (?,?,?,3,?)"
          )
          .bind(
            migratedPreviousMac.deviceId,
            migratedUserId,
            migratedPreviousMac.publicKeyEncoded,
            epoch - 100
          ),
      ])
      users.set(migratedUserId, { emailVerified: true })
    }
    const sql = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8"
    )
    await database.batch(
      unstable_splitSqlQuery(sql).map((statement) =>
        database.prepare(statement)
      )
    )
  }
  oldSubscription = {
    id: "subscription-before-migration",
    userId: "user_before_device_migration",
    type: "trial",
    status: "active",
    startsAt: epoch,
    endsAt: epoch + 30 * 86_400_000,
    updatedAt: epoch,
    revision: 1,
    notes: "",
    bindingRevision: 1,
    devices: [],
    deviceLimit: 2,
    cancelAtPeriodEnd: false,
    canceledAt: null,
  }
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

async function desktopSession(userId, mac, now = epoch, active = true) {
  const id = randomUUID()
  await database
    .prepare(
      `INSERT INTO desktop_sessions (id, device_id, user_id, email, public_key, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      mac.deviceId,
      userId,
      `${userId}@example.com`,
      mac.publicKeyEncoded,
      active ? 1 : 0,
      now,
      now
    )
    .run()
  return id
}

test("administrative Mac history includes active and revoked desktop sessions without exposing signing keys", async () => {
  const userId = "user_admin_session_history"
  await assign(userId)
  const activeMac = device(),
    revokedMac = device()
  await desktopSession(userId, revokedMac, epoch, false)
  await desktopSession(userId, activeMac, epoch + 1)

  const history = await listSubscriptionDevices(database, userId)
  assert.deepEqual(history, [
    {
      id: activeMac.deviceId,
      bindingRevision: 1,
      assignmentRevision: 1,
      activatedAt: epoch + 1,
      current: true,
    },
    {
      id: revokedMac.deviceId,
      bindingRevision: 1,
      assignmentRevision: 1,
      activatedAt: epoch,
      current: false,
    },
  ])
  assert.equal(
    JSON.stringify(history).includes(activeMac.publicKeyEncoded),
    false
  )
  assert.equal(
    JSON.stringify(history).includes(revokedMac.publicKeyEncoded),
    false
  )
})

test("administrative Mac history lists migrated devices once and keeps their current session after reapproval", async () => {
  const userId = "user_admin_migrated_session_history"
  await assign(userId)
  const mac = device()
  await bind(userId, mac)
  await desktopSession(userId, mac, epoch - 1, false)
  const sessionId = await desktopSession(userId, mac, epoch + 1)

  let history = await listSubscriptionDevices(database, userId)
  assert.equal(history.length, 1)
  assert.equal(history[0].current, true)
  assert.equal(history[0].activatedAt, epoch + 1)

  await revokeDesktopSession(database, sessionId, userId, 1, epoch + 2)
  history = await listSubscriptionDevices(database, userId)
  assert.equal(history.length, 1)
  assert.equal(history[0].current, false)
  assert.equal(history[0].assignmentRevision, 2)

  await desktopSession(userId, mac, epoch + 3)
  history = await listSubscriptionDevices(database, userId)
  assert.equal(history.length, 1)
  assert.equal(history[0].current, true)
  assert.equal(history[0].activatedAt, epoch + 3)
  assert.equal(history[0].assignmentRevision, 1)
})

test("administrative Mac history retains a reconnected legacy assignment after an older desktop session was revoked", async () => {
  const userId = "user_admin_legacy_session_history"
  await assign(userId)
  const mac = device()
  await desktopSession(userId, mac, epoch, false)
  await bind(userId, mac, epoch + 1)

  const history = await listSubscriptionDevices(database, userId)
  assert.equal(history.length, 1)
  assert.equal(history[0].current, true)
  assert.equal(history[0].activatedAt, epoch + 1)
})

test("an administrative reset of one session-only Mac updates its history and leaves the other Mac active", async () => {
  const userId = "user_admin_session_reset"
  const subscription = await assign(userId)
  const first = device(),
    second = device()
  const firstSession = await desktopSession(userId, first)
  const secondSession = await desktopSession(userId, second, epoch + 1)

  const reset = await resetSubscriptionDevice(
    database,
    userId,
    subscription.revision,
    actor,
    epoch + 2,
    "Remove only this computer",
    first.deviceId
  )
  assert.deepEqual(
    reset.devices.map(({ id }) => id),
    [second.deviceId]
  )
  const history = await listSubscriptionDevices(database, userId)
  assert.equal(history.find(({ id }) => id === first.deviceId).current, false)
  assert.equal(history.find(({ id }) => id === second.deviceId).current, true)
  const sessions = await database
    .prepare("SELECT id, active FROM desktop_sessions WHERE id IN (?, ?)")
    .bind(firstSession, secondSession)
    .all()
  assert.equal(sessions.results.find(({ id }) => id === firstSession).active, 0)
  assert.equal(
    sessions.results.find(({ id }) => id === secondSession).active,
    1
  )
})

test("administrative Mac history includes desktop sessions for accounts without subscriptions", async () => {
  const userId = "user_admin_free_session_history"
  const mac = device()
  await desktopSession(userId, mac)
  const history = await listSubscriptionDevices(database, userId)
  assert.equal(history.length, 1)
  assert.equal(history[0].id, mac.deviceId)
  assert.equal(history[0].current, true)
})

// Frozen pre-two-slot SQL exercises the backend that is still live while the
// migrations are applied, including its omitted active/assignment columns.
async function legacyBind(userId, mac, now = epoch) {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE subscriptions SET current_device_id = ?,
      revision = revision + CASE WHEN current_device_id IS NULL THEN 1 ELSE 0 END,
      updated_at = CASE WHEN current_device_id IS NULL THEN ? ELSE updated_at END
      WHERE user_id = ? AND status = 'active' AND started_at <= ? AND end_at > ?
      AND (current_device_id IS NULL OR current_device_id = ?)
      AND NOT EXISTS (SELECT 1 FROM account_devices d WHERE d.device_id = ? AND d.user_id != ?)
      RETURNING *`
      )
      .bind(
        mac.deviceId,
        now,
        userId,
        now,
        now,
        mac.deviceId,
        mac.deviceId,
        userId
      ),
    database
      .prepare(
        `INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at)
      SELECT ?,user_id,?,binding_revision,? FROM subscriptions WHERE user_id=? AND current_device_id=?
      AND status='active' AND started_at<=? AND end_at>? AND changes()=1
      ON CONFLICT(device_id) DO UPDATE SET binding_revision=excluded.binding_revision,
      activated_at=CASE WHEN account_devices.binding_revision!=excluded.binding_revision
        THEN excluded.activated_at ELSE account_devices.activated_at END
      WHERE account_devices.user_id=excluded.user_id AND account_devices.public_key=excluded.public_key`
      )
      .bind(
        mac.deviceId,
        mac.publicKeyEncoded,
        now,
        userId,
        mac.deviceId,
        now,
        now
      ),
    database
      .prepare(
        `INSERT INTO subscription_audit (id,subscription_id,action,actor,created_at,detail)
      SELECT ?,id,'bind-device',user_id,?,'Mac connected / assignment ' || binding_revision || ' / ' || current_device_id
      FROM subscriptions WHERE user_id=? AND current_device_id=? AND changes()=1
      AND NOT EXISTS (SELECT 1 FROM subscription_audit a WHERE a.subscription_id=subscriptions.id
        AND a.action='bind-device' AND a.detail='Mac connected / assignment ' || binding_revision || ' / ' || current_device_id)`
      )
      .bind(randomUUID(), now, userId, mac.deviceId),
    database
      .prepare(
        `SELECT s.*,d.binding_revision AS device_binding_revision FROM account_devices d
      JOIN subscriptions s ON s.user_id=d.user_id WHERE d.device_id=?`
      )
      .bind(mac.deviceId),
  ])
  return results[3].results[0]
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

function verifyRequest(mac, bindings = env, changes = {}, headers = {}) {
  return handleLicenseRequest(
    new Request(`${origin}/api/licenses/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `account-test-${sequence++}`,
        ...headers,
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
    .prepare("SELECT binding_revision FROM subscriptions WHERE user_id = ?")
    .bind(oldSubscription.userId)
    .first()
  assert.deepEqual(row, { binding_revision: 1 })
  assert.equal(
    (
      await database
        .prepare(
          "SELECT count(*) AS count FROM account_devices WHERE user_id = ?"
        )
        .bind(oldSubscription.userId)
        .first()
    ).count,
    0
  )
  assert.deepEqual(
    await listSubscriptionAudit(database, oldSubscription.userId),
    [
      {
        id: "audit-before-migration",
        action: "set",
        actor,
        createdAt: epoch,
        detail: "Existing trial",
        reason: "",
      },
    ]
  )
})

test("two-Mac migration preserves the current single Mac, notes and old revoked signing identities", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const subscription = await getSubscription(database, migratedUserId, epoch)
  assert.equal(subscription.deviceLimit, 2)
  assert.equal(subscription.revision, 7)
  assert.equal(subscription.bindingRevision, 4)
  assert.equal(subscription.notes, "Retained notes")
  assert.deepEqual(subscription.devices, [
    {
      id: migratedMac.deviceId,
      bindingRevision: 4,
      assignmentRevision: 1,
      activatedAt: epoch,
    },
  ])
  assert.equal(
    (await getSubscriptionDevice(database, migratedMac.deviceId, epoch)).active,
    true
  )
  assert.equal(
    (await getSubscriptionDevice(database, migratedPreviousMac.deviceId, epoch))
      .active,
    false
  )
  assert.equal(
    (await receipt(await verifyRequest(migratedMac))).status,
    "active"
  )
  assert.equal(
    (await receipt(await verifyRequest(migratedPreviousMac))).status,
    "revoked"
  )
  const auditBefore = await listSubscriptionAudit(database, migratedUserId)
  assert.deepEqual(
    (await bind(migratedUserId, migratedMac)).subscription,
    subscription
  )
  assert.deepEqual(
    await listSubscriptionAudit(database, migratedUserId),
    auditBefore
  )
})

test("migration handoff admits legacy inserts and returning upserts while preserving Mac revisions", async () => {
  const userId = "user_legacy_migration_handoff"
  await assign(userId)
  const mac = device()
  const inserted = await legacyBind(userId, mac)
  assert.equal(inserted.current_device_id, mac.deviceId)
  let deviceState = await getSubscriptionDevice(database, mac.deviceId, epoch)
  assert.equal(deviceState.active, true)
  assert.equal(deviceState.assignmentRevision, 1)
  assert.equal(deviceState.subscription.devices.length, 1)
  // An old reset changes the account epoch without updating the active column.
  await database
    .prepare(
      `UPDATE subscriptions SET current_device_id=NULL,binding_revision=binding_revision+1,
    revision=revision+1 WHERE user_id=?`
    )
    .bind(userId)
    .run()
  assert.equal(
    (await getSubscriptionDevice(database, mac.deviceId, epoch)).active,
    false
  )
  const returned = await legacyBind(userId, mac, epoch + 1)
  assert.equal(returned.current_device_id, mac.deviceId)
  deviceState = await getSubscriptionDevice(database, mac.deviceId, epoch)
  assert.equal(deviceState.active, true)
  assert.equal(deviceState.assignmentRevision, 1)
  assert.equal(deviceState.bindingRevision, 2)
  assert.equal(deviceState.subscription.devices.length, 1)
  const reset = await resetSubscriptionDevice(
    database,
    userId,
    deviceState.subscription.revision,
    actor,
    epoch + 2,
    "Single reset during handoff",
    mac.deviceId
  )
  const legacyProof = await database
    .prepare(
      `SELECT s.current_device_id,s.binding_revision,
    d.binding_revision AS device_binding_revision FROM account_devices d JOIN subscriptions s ON s.user_id=d.user_id
    WHERE d.device_id=?`
    )
    .bind(mac.deviceId)
    .first()
  assert.equal(legacyProof.current_device_id, null)
  assert.equal(reset.bindingRevision, 2)
  assert.equal(
    (await getSubscriptionDevice(database, mac.deviceId, epoch))
      .assignmentRevision,
    2
  )
  // A returning old upsert after an account epoch reset retains the individual
  // revision instead of overwriting it with the newly added column's default.
  await database
    .prepare(
      `UPDATE subscriptions SET current_device_id=NULL,binding_revision=binding_revision+1,
    revision=revision+1 WHERE user_id=?`
    )
    .bind(userId)
    .run()
  await legacyBind(userId, mac, epoch + 3)
  deviceState = await getSubscriptionDevice(database, mac.deviceId, epoch)
  assert.equal(deviceState.active, true)
  assert.equal(deviceState.bindingRevision, 3)
  assert.equal(deviceState.assignmentRevision, 2)
})

test("legacy handoff activation cannot bypass the two-Mac database guard", async () => {
  const userId = "user_legacy_handoff_capacity"
  await assign(userId)
  const first = device(),
    second = device(),
    third = device()
  await bind(userId, first)
  await bind(userId, second)
  const before = await getSubscription(database, userId, epoch)
  await assert.rejects(legacyBind(userId, third), /two connected Macs/)
  assert.deepEqual(await getSubscription(database, userId, epoch), before)
  assert.equal(
    await getSubscriptionDevice(database, third.deviceId, epoch),
    null
  )
  assert.equal(
    (
      await database
        .prepare("SELECT current_device_id FROM subscriptions WHERE user_id=?")
        .bind(userId)
        .first()
    ).current_device_id,
    null
  )
})

test("concurrent Mac sign-ins claim exactly two slots and reconnecting either current Mac is idempotent", async () => {
  const userId = "user_two_macs"
  const subscription = await assign(userId)
  const macs = Array.from({ length: 8 }, device)
  const results = await Promise.all(macs.map((mac) => bind(userId, mac)))
  const winners = results.flatMap((result, index) =>
    result ? [{ result, mac: macs[index] }] : []
  )
  assert.equal(winners.length, 2)
  const currentSubscription = await getSubscription(database, userId, epoch)
  assert.equal(currentSubscription.revision, 3)
  assert.equal(currentSubscription.deviceLimit, 2)
  assert.deepEqual(
    currentSubscription.devices.map(({ id }) => id).sort(),
    winners.map(({ mac }) => mac.deviceId).sort()
  )
  for (const { result, mac } of winners) {
    assert.equal(result.userId, userId)
    assert.equal(result.publicKey, mac.publicKeyEncoded)
    assert.equal(result.active, true)
    assert.equal(result.bindingRevision, result.currentBindingRevision)
    assert.equal(result.subscription.id, subscription.id)
    const reconnected = await bind(userId, mac, epoch + 100)
    assert.equal(reconnected.active, true)
    assert.deepEqual(reconnected.subscription, currentSubscription)
    assert.deepEqual(
      await getSubscriptionDevice(database, mac.deviceId, epoch),
      reconnected
    )
    assert.equal(
      await bindSubscriptionDevice(
        database,
        {
          userId,
          deviceId: mac.deviceId,
          publicKey: mac.publicKeyEncoded,
          expectedBindingRevision: result.currentBindingRevision + 1,
        },
        epoch + 200
      ),
      null
    )
  }
  assert.equal((await listSubscriptionAudit(database, userId)).length, 3)
  for (const mac of macs.filter(
    (mac) => !winners.some((winner) => winner.mac === mac)
  ))
    assert.equal(
      await getSubscriptionDevice(database, mac.deviceId, epoch),
      null
    )
  await assert.rejects(
    database
      .prepare(
        "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active) VALUES (?,?,?,1,?,1)"
      )
      .bind("f".repeat(64), userId, "cannot-bypass-slots", epoch)
      .run(),
    /two connected Macs/
  )
  assert.equal(
    (await getSubscription(database, userId, epoch)).devices.length,
    2
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
  assert.equal(old.active, false)
  assert.equal(old.publicKey, oldMac.publicKeyEncoded)
  assert.ok(old.bindingRevision < old.currentBindingRevision)
  const replacement = await bind(userId, newMac, epoch + 200)
  assert.equal(replacement.subscription.revision, 4)
  assert.equal(replacement.active, true)
  assert.equal(replacement.subscription.devices[0].id, newMac.deviceId)
  assert.equal(await bind(userId, oldMac, epoch + 300), null)
  assert.equal(
    (await getSubscriptionDevice(database, oldMac.deviceId, epoch + 300))
      .active,
    false
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

test("live verification negotiates subscription expiry without breaking legacy receipt schemas", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_verify_receipt_versions"
  const subscription = await assign(userId, { endsAt: epoch + 30 * 60_000 })
  const mac = device()
  await bind(userId, mac)
  for (const version of [undefined, "1", "2", "3"]) {
    const response = await verifyRequest(
      mac,
      env,
      {},
      version ? { "Photodepot-Receipt-Version": version } : {}
    )
    const envelope = await response.clone().json()
    const payload = await receipt(response)
    assert.equal(payload.expiresAt, subscription.endsAt)
    assert.equal(
      payload.subscriptionEndsAt,
      ["2", "3"].includes(version) ? subscription.endsAt : undefined
    )
    assert.deepEqual(
      Object.keys(payload).sort(),
      [
        "version",
        "licenseId",
        "deviceId",
        "type",
        "status",
        "challenge",
        "revision",
        "issuedAt",
        "expiresAt",
        ...(["2", "3"].includes(version) ? ["subscriptionEndsAt"] : []),
      ].sort()
    )
    assert.deepEqual(
      Object.keys(envelope).sort(),
      [
        "payload",
        "signature",
        ...(["2", "3"].includes(version) ? ["collaborationReceipt"] : []),
      ].sort()
    )
    if (["2", "3"].includes(version)) {
      const compatible = await receipt(
        Response.json(envelope.collaborationReceipt, {
          headers: { "cache-control": "private, no-store" },
        })
      )
      const expected = { ...payload }
      delete expected.subscriptionEndsAt
      assert.deepEqual(compatible, expected)
      assert.deepEqual(Object.keys(envelope.collaborationReceipt).sort(), [
        "payload",
        "signature",
      ])
    }
  }
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

test("an individual reset invalidates only that Mac, preserves the other slot and rejects unauthorized or stale resets", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_individual_reset"
  const unrelatedUser = "user_individual_reset_other"
  await assign(userId)
  await assign(unrelatedUser)
  const firstMac = device(),
    otherMac = device(),
    replacementMac = device()
  await bind(userId, firstMac)
  await bind(userId, otherMac)
  const before = await getSubscription(database, userId, epoch)
  assert.equal(before.devices.length, 2)
  await assert.rejects(
    resetSubscriptionDevice(
      database,
      unrelatedUser,
      1,
      actor,
      epoch,
      "Wrong account",
      firstMac.deviceId
    ),
    SubscriptionConflictError
  )
  await assert.rejects(
    resetSubscriptionDevice(
      database,
      userId,
      2,
      actor,
      epoch,
      "Stale revision",
      firstMac.deviceId
    ),
    SubscriptionConflictError
  )
  assert.deepEqual(await getSubscription(database, userId, epoch), before)
  assert.equal((await listSubscriptionAudit(database, unrelatedUser)).length, 1)
  const reset = await resetSubscriptionDevice(
    database,
    userId,
    3,
    actor,
    epoch + 1,
    "Lost Mac",
    firstMac.deviceId
  )
  assert.equal(reset.revision, 4)
  assert.equal(reset.bindingRevision, before.bindingRevision)
  assert.deepEqual(
    reset.devices.map(({ id }) => id),
    [otherMac.deviceId]
  )
  const old = await getSubscriptionDevice(database, firstMac.deviceId, epoch)
  assert.equal(old.active, false)
  assert.equal(old.assignmentRevision, 2)
  assert.equal(old.bindingRevision, old.currentBindingRevision)
  assert.equal(old.publicKey, firstMac.publicKeyEncoded)
  assert.equal(
    (await getSubscriptionDevice(database, otherMac.deviceId, epoch)).active,
    true
  )
  assert.equal((await receipt(await verifyRequest(firstMac))).status, "revoked")
  assert.equal((await receipt(await verifyRequest(otherMac))).status, "active")
  assert.equal(await bind(userId, firstMac), null)
  const replacement = await bind(userId, replacementMac, epoch + 2)
  assert.equal(replacement.subscription.revision, 5)
  assert.deepEqual(
    replacement.subscription.devices.map(({ id }) => id).sort(),
    [otherMac.deviceId, replacementMac.deviceId].sort()
  )
  assert.equal((await receipt(await verifyRequest(firstMac))).status, "revoked")
  assert.equal((await receipt(await verifyRequest(otherMac))).status, "active")
  await assert.rejects(
    resetSubscriptionDevice(
      database,
      userId,
      5,
      actor,
      epoch + 3,
      "Already reset",
      firstMac.deviceId
    ),
    SubscriptionConflictError
  )
  assert.equal((await listSubscriptionAudit(database, userId)).length, 5)
})

test("an individual reset audit failure rolls back the Mac epoch and leaves both assignments active", async () => {
  const userId = "user_individual_reset_atomic"
  await assign(userId)
  const firstMac = device(),
    secondMac = device()
  await bind(userId, firstMac)
  await bind(userId, secondMac)
  const before = await getSubscription(database, userId, epoch)
  await database
    .prepare(
      `CREATE TRIGGER reject_individual_reset_audit BEFORE INSERT ON subscription_audit
    WHEN NEW.action = 'reset-device' AND NEW.reason = 'reject-single-reset'
    BEGIN SELECT RAISE(ABORT, 'single reset audit unavailable'); END`
    )
    .run()
  try {
    await assert.rejects(
      resetSubscriptionDevice(
        database,
        userId,
        3,
        actor,
        epoch + 1,
        "reject-single-reset",
        firstMac.deviceId
      ),
      /single reset audit unavailable/
    )
    assert.deepEqual(await getSubscription(database, userId, epoch), before)
    const current = await getSubscriptionDevice(
      database,
      firstMac.deviceId,
      epoch
    )
    assert.equal(current.assignmentRevision, 1)
    assert.equal(current.active, true)
    assert.equal((await listSubscriptionAudit(database, userId)).length, 3)
  } finally {
    await database.prepare("DROP TRIGGER reject_individual_reset_audit").run()
  }
})

test("live verification rechecks resets, revocation and expiration after an in-flight WorkOS lookup", async (t) => {
  let currentTime = epoch
  t.mock.method(Date, "now", () => currentTime)
  const savedFetch = globalThis.fetch
  for (const action of ["individual-reset", "reset-all", "revoke", "expire"]) {
    currentTime = epoch
    const userId = `user_verify_race_${action.replaceAll("-", "_")}`
    await assign(userId, { endsAt: epoch + 100 })
    const mac = device()
    await bind(userId, mac)
    const otherMac = action === "individual-reset" ? device() : null
    if (otherMac) await bind(userId, otherMac)
    const original = await getSubscription(database, userId, epoch)
    let latest = original
    globalThis.fetch = async (...args) => {
      const response = await savedFetch(...args)
      if (action === "expire") currentTime = epoch + 100
      else if (action === "revoke")
        latest = await changeSubscription(
          database,
          userId,
          "revoke",
          original.revision,
          actor,
          undefined,
          epoch
        )
      else
        latest = await resetSubscriptionDevice(
          database,
          userId,
          original.revision,
          actor,
          epoch,
          "Changed during verification",
          action === "individual-reset" ? mac.deviceId : undefined
        )
      return response
    }
    try {
      const response = await verifyRequest(
        mac,
        env,
        {},
        {
          "Photodepot-Receipt-Version": "3",
        }
      )
      assert.equal(response.status, 200)
      const payload = await receipt(response)
      assert.equal(payload.status, "revoked", action)
      assert.equal(payload.revision, latest.revision, action)
      assert.equal(payload.issuedAt, currentTime)
      assert.equal(
        payload.revocationReason,
        action === "individual-reset" || action === "reset-all"
          ? "device-removed"
          : undefined,
        action
      )
      if (otherMac) {
        const other = await getSubscriptionDevice(
          database,
          otherMac.deviceId,
          currentTime
        )
        assert.equal(other.active, true)
      }
    } finally {
      globalThis.fetch = savedFetch
    }
  }
})
