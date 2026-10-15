import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import {
  changeSubscription,
  changeSubscriptionRenewal,
  getSubscriptionOverview,
  getSubscription,
  listSubscriptionAudit,
  listSubscriptions,
  setSubscription,
  updateSubscriptionNotes,
  SubscriptionConflictError,
} from "../lib/subscription-store.ts"

const now = 1_800_000_000_000
const day = 24 * 60 * 60 * 1000
const actor = "owner@example.com"
const legacyLicenseId = "00000000-0000-4000-8000-000000000001"
let platform, database, legacySnapshot

async function migrate(filename) {
  const source = await readFile(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8"
  )
  await database.batch(
    unstable_splitSqlQuery(source).map((sql) => database.prepare(sql))
  )
}

async function legacyRows() {
  const tables = [
    "waitlist",
    "download_attempts",
    "licenses",
    "license_devices",
    "license_audit",
    "license_attempts",
  ]
  return Promise.all(
    tables.map(
      async (table) =>
        (await database.prepare(`SELECT * FROM ${table}`).all()).results
    )
  )
}

before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  database = platform.env.DB
  await migrate("0001_waitlist.sql")
  await migrate("0002_licenses.sql")
  await database.batch([
    database
      .prepare(
        "INSERT INTO waitlist (first_name, email, heard_about_us) VALUES (?, ?, ?)"
      )
      .bind("Existing", "existing@example.com", "A friend"),
    database
      .prepare(
        "INSERT INTO download_attempts (key, attempts, expires_at) VALUES (?, ?, ?)"
      )
      .bind("existing-download", 2, now),
    database
      .prepare(
        "INSERT INTO licenses (id, key_hash, key_suffix, type, customer_name, email, current_device_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        legacyLicenseId,
        "legacy-key-hash",
        "ABCD",
        "regular",
        "Existing Customer",
        "existing@example.com",
        "legacy-device",
        now,
        now
      ),
    database
      .prepare(
        "INSERT INTO license_devices (device_id, license_id, public_key, binding_revision, activated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind("legacy-device", legacyLicenseId, "legacy-public-key", 1, now),
    database
      .prepare(
        "INSERT INTO license_audit (id, license_id, action, actor, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        "legacy-audit",
        legacyLicenseId,
        "grant",
        actor,
        now,
        "Existing license"
      ),
    database
      .prepare(
        "INSERT INTO license_attempts (key, attempts, expires_at) VALUES (?, ?, ?)"
      )
      .bind("existing-license-attempt", 3, now),
  ])
  legacySnapshot = await legacyRows()
  await migrate("0003_subscriptions.sql")
  await migrate("0004_account_devices.sql")
  await migrate("0005_account_pairings.sql")
  await migrate("0006_subscription_management.sql")
  await migrate("0007_two_mac_assignments.sql")
  await migrate("0008_account_requests.sql")
  await migrate("0009_subscription_reminders.sql")
  await migrate("0010_subscription_renewal_preferences.sql")
  await migrate("0011_desktop_account_sessions.sql")
  await migrate("0012_desktop_device_metadata.sql")
})

after(async () => {
  await platform?.dispose()
})

function set(userId, values = {}, at = now) {
  return setSubscription(
    database,
    {
      userId,
      type: "trial",
      endsAt: at + 30 * day,
      expectedRevision: 0,
      ...values,
    },
    actor,
    at
  )
}

test("subscription migration preserves existing license, device, audit, rate-limit and waitlist data", async () => {
  assert.deepEqual(await legacyRows(), legacySnapshot)
  assert.equal(
    (
      await database
        .prepare("SELECT count(*) AS count FROM subscriptions")
        .first()
    ).count,
    0
  )
})

test("listing a WorkOS user does not itself assign a subscription", async () => {
  const userId = "user_ungranted"
  assert.equal(await getSubscription(database, userId, now), null)
  assert.deepEqual(await listSubscriptions(database, [userId], now), new Map())
  assert.deepEqual(await listSubscriptions(database, [], now), new Map())
  assert.deepEqual(await listSubscriptionAudit(database, userId), [])
})

test("trial and regular access expires at the exact end boundary without rewriting persisted state", async () => {
  for (const type of ["trial", "regular"]) {
    const userId = `user_boundary_${type}`
    const subscription = await set(userId, { type, endsAt: now + day })
    assert.match(
      subscription.id,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    )
    assert.equal(subscription.userId, userId)
    assert.equal(subscription.startsAt, now)
    assert.equal(subscription.updatedAt, now)
    assert.equal(subscription.revision, 1)
    assert.equal(subscription.status, "active")
    assert.equal(
      (await getSubscription(database, userId, now + day - 1)).status,
      "active"
    )
    assert.equal(
      (await getSubscription(database, userId, now + day)).status,
      "expired"
    )
    assert.equal(
      (await getSubscription(database, userId, now + day + 1)).status,
      "expired"
    )
    const row = await database
      .prepare("SELECT status, revision FROM subscriptions WHERE user_id = ?")
      .bind(userId)
      .first()
    assert.deepEqual(row, { status: "active", revision: 1 })
    const audit = await listSubscriptionAudit(database, userId)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].action, "set")
    assert.equal(audit[0].actor, actor)
    assert.equal(audit[0].createdAt, now)
  }
})

test("revocation takes precedence over expiry and restoring an expired subscription does not extend it", async () => {
  const userId = "user_revocation"
  const original = await set(userId, { endsAt: now + 100 })
  const revoked = await changeSubscription(
    database,
    userId,
    "revoke",
    1,
    actor,
    undefined,
    now + 50
  )
  assert.equal(revoked.status, "revoked")
  assert.equal(revoked.revision, 2)
  assert.equal(
    (await getSubscription(database, userId, now + 150)).status,
    "revoked"
  )
  const restored = await changeSubscription(
    database,
    userId,
    "restore",
    2,
    actor,
    undefined,
    now + 150
  )
  assert.equal(restored.status, "expired")
  assert.equal(restored.startsAt, original.startsAt)
  assert.equal(restored.endsAt, original.endsAt)
  assert.equal(restored.updatedAt, now + 150)
  assert.equal(restored.revision, 3)
  assert.deepEqual(
    (await listSubscriptionAudit(database, userId)).map(({ action }) => action),
    ["restore", "revoke", "set"]
  )
})

test("extensions add time from the later of now or expiry and preserve revoked status", async () => {
  const userId = "user_extension"
  const original = await set(userId, { endsAt: now + day })
  const extended = await changeSubscription(
    database,
    userId,
    "extend",
    1,
    actor,
    7,
    now + 100
  )
  assert.equal(extended.endsAt, now + 8 * day)
  assert.equal(extended.startsAt, original.startsAt)
  const afterExpiry = now + 10 * day
  const renewed = await changeSubscription(
    database,
    userId,
    "extend",
    2,
    actor,
    2,
    afterExpiry
  )
  assert.equal(renewed.endsAt, afterExpiry + 2 * day)
  assert.equal(renewed.status, "active")
  const revoked = await changeSubscription(
    database,
    userId,
    "revoke",
    3,
    actor,
    undefined,
    afterExpiry + 100
  )
  const revokedExtension = await changeSubscription(
    database,
    userId,
    "extend",
    revoked.revision,
    actor,
    1,
    afterExpiry + 200
  )
  assert.equal(revokedExtension.status, "revoked")
  assert.equal(revokedExtension.endsAt, afterExpiry + 3 * day)
  const restored = await changeSubscription(
    database,
    userId,
    "restore",
    revokedExtension.revision,
    actor,
    undefined,
    afterExpiry + 300
  )
  assert.equal(restored.status, "active")
  assert.equal(restored.endsAt, revokedExtension.endsAt)
})

test("setting a replacement subscription requires the current revision and starts its explicit grant now", async () => {
  const userId = "user_replacement"
  const first = await set(userId)
  const replacement = await set(
    userId,
    { type: "regular", expectedRevision: 1, endsAt: now + 60 * day },
    now + day
  )
  assert.equal(replacement.id, first.id)
  assert.equal(replacement.type, "regular")
  assert.equal(replacement.startsAt, now + day)
  assert.equal(replacement.endsAt, now + 60 * day)
  assert.equal(replacement.revision, 2)
  await assert.rejects(
    set(userId, { expectedRevision: 1 }),
    SubscriptionConflictError
  )
  assert.equal((await listSubscriptionAudit(database, userId)).length, 2)
  assert.deepEqual(
    await getSubscription(database, userId, now + day),
    replacement
  )
})

test("concurrent first grants and edits permit exactly one revision winner and never audit losing writes", async () => {
  const userId = "user_concurrent"
  const grants = await Promise.allSettled(
    Array.from({ length: 6 }, () => set(userId))
  )
  assert.equal(grants.filter(({ status }) => status === "fulfilled").length, 1)
  for (const result of grants.filter(({ status }) => status === "rejected"))
    assert.ok(result.reason instanceof SubscriptionConflictError)
  assert.equal((await listSubscriptionAudit(database, userId)).length, 1)
  const edits = await Promise.allSettled([
    changeSubscription(
      database,
      userId,
      "revoke",
      1,
      actor,
      undefined,
      now + 100
    ),
    changeSubscription(database, userId, "extend", 1, actor, 3, now + 100),
    set(userId, { type: "regular", expectedRevision: 1 }, now + 100),
  ])
  assert.equal(edits.filter(({ status }) => status === "fulfilled").length, 1)
  for (const result of edits.filter(({ status }) => status === "rejected"))
    assert.ok(result.reason instanceof SubscriptionConflictError)
  const winner = edits.find(({ status }) => status === "fulfilled").value
  assert.equal(winner.revision, 2)
  assert.deepEqual(await getSubscription(database, userId, now + 100), winner)
  assert.equal((await listSubscriptionAudit(database, userId)).length, 2)
  await assert.rejects(
    changeSubscription(
      database,
      "user_missing_revision",
      "restore",
      0,
      actor,
      undefined,
      now
    ),
    SubscriptionConflictError
  )
  assert.deepEqual(
    await listSubscriptionAudit(database, "user_missing_revision"),
    []
  )
})

test("an audit insertion failure rolls back both new grants and existing subscription edits", async () => {
  const userId = "user_atomicity"
  const original = await set(userId)
  await database
    .prepare(
      `CREATE TRIGGER reject_subscription_audit BEFORE INSERT ON subscription_audit
    WHEN NEW.actor = 'blocked@example.com'
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`
    )
    .run()
  try {
    await assert.rejects(
      changeSubscription(
        database,
        userId,
        "revoke",
        1,
        "blocked@example.com",
        undefined,
        now + 100
      ),
      /audit unavailable/
    )
    assert.deepEqual(await getSubscription(database, userId, now), original)
    assert.equal((await listSubscriptionAudit(database, userId)).length, 1)
    await assert.rejects(
      setSubscription(
        database,
        {
          userId: "user_atomicity_new",
          type: "trial",
          endsAt: now + day,
          expectedRevision: 0,
        },
        "blocked@example.com",
        now
      ),
      /audit unavailable/
    )
    assert.equal(
      await getSubscription(database, "user_atomicity_new", now),
      null
    )
    assert.deepEqual(
      await listSubscriptionAudit(database, "user_atomicity_new"),
      []
    )
  } finally {
    await database.prepare("DROP TRIGGER reject_subscription_audit").run()
  }
})

test("invalid subscription dates, types, revisions and extension durations never change access or audits", async () => {
  const userId = "user_validation"
  for (const changes of [
    { type: "paid" },
    { endsAt: now },
    { endsAt: now - 1 },
    { endsAt: Number.NaN },
    { endsAt: 8_640_000_000_000_001 },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { userId: "user_bad'; DROP TABLE subscriptions;--" },
  ])
    await assert.rejects(set(userId, changes), TypeError)
  const original = await set(userId)
  for (const days of [
    undefined,
    0,
    -1,
    0.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])
    await assert.rejects(
      changeSubscription(database, userId, "extend", 1, actor, days, now),
      TypeError
    )
  await assert.rejects(
    changeSubscription(database, userId, "delete", 1, actor, undefined, now),
    TypeError
  )
  assert.deepEqual(await getSubscription(database, userId, now), original)
  assert.equal((await listSubscriptionAudit(database, userId)).length, 1)
})

test("subscription lookup limits SQL parameters, deduplicates users and returns only assigned accounts", async () => {
  const users = Array.from(
    { length: 205 },
    (_, index) => `user_listing_${index}`
  )
  const first = await set(users[0], { type: "trial", endsAt: now + 100 })
  const last = await set(users.at(-1), { type: "regular", endsAt: now + day })
  const result = await listSubscriptions(
    database,
    [...users, users[0]],
    now + 100
  )
  assert.equal(result.size, 2)
  assert.deepEqual(result.get(users[0]), { ...first, status: "expired" })
  assert.deepEqual(result.get(users.at(-1)), last)
  assert.equal(result.has(users[1]), false)
})

test("administrator notes and action reasons preserve access and participate in revision guards", async () => {
  const userId = "user_admin_notes"
  const original = await set(userId, {
    notes: "  Manual enterprise grant  ",
    reason: "  Approved by owner  ",
  })
  assert.equal(original.notes, "Manual enterprise grant")
  assert.equal(
    (await listSubscriptionAudit(database, userId))[0].reason,
    "Approved by owner"
  )
  const noted = await updateSubscriptionNotes(
    database,
    userId,
    "Customer requested a replacement Mac",
    1,
    actor,
    now + 1,
    "Support case 123"
  )
  assert.equal(noted.notes, "Customer requested a replacement Mac")
  assert.equal(noted.endsAt, original.endsAt)
  assert.equal(noted.startsAt, original.startsAt)
  assert.equal(noted.status, original.status)
  assert.equal(noted.revision, 2)
  const audit = await listSubscriptionAudit(database, userId)
  assert.equal(audit[0].action, "update-notes")
  assert.equal(audit[0].reason, "Support case 123")
  assert.match(audit[0].detail, /replacement Mac/)
  await assert.rejects(
    updateSubscriptionNotes(database, userId, "stale", 1, actor, now + 2),
    SubscriptionConflictError
  )
  const replacement = await set(
    userId,
    { type: "regular", expectedRevision: 2 },
    now + 3
  )
  assert.equal(replacement.notes, noted.notes)
  const cleared = await updateSubscriptionNotes(
    database,
    userId,
    "",
    3,
    actor,
    now + 4
  )
  assert.equal(cleared.notes, "")
  for (const notes of [null, "a".repeat(2001)])
    await assert.rejects(
      updateSubscriptionNotes(database, userId, notes, 4, actor, now + 5),
      TypeError
    )
  await assert.rejects(
    changeSubscription(
      database,
      userId,
      "revoke",
      4,
      actor,
      undefined,
      now + 5,
      { reason: "a".repeat(1001) }
    ),
    TypeError
  )
  assert.equal((await getSubscription(database, userId, now + 5)).revision, 4)
})

test("exact expiration extensions preserve the start, type, notes and revocation and cannot shorten access", async () => {
  const userId = "user_exact_extension"
  const original = await set(userId, { notes: "Keep notes" })
  await changeSubscription(database, userId, "revoke", 1, actor, undefined, now)
  const extended = await changeSubscription(
    database,
    userId,
    "extend",
    2,
    actor,
    undefined,
    now + 1,
    { endsAt: now + 45 * day, reason: "Annual adjustment" }
  )
  assert.equal(extended.endsAt, now + 45 * day)
  assert.equal(extended.startsAt, original.startsAt)
  assert.equal(extended.type, original.type)
  assert.equal(extended.notes, original.notes)
  assert.equal(extended.status, "revoked")
  assert.equal(
    (await listSubscriptionAudit(database, userId))[0].reason,
    "Annual adjustment"
  )
  for (const endsAt of [now, now + 10 * day, extended.endsAt])
    await assert.rejects(
      changeSubscription(database, userId, "extend", 3, actor, undefined, now, {
        endsAt,
      }),
      TypeError
    )
  await assert.rejects(
    changeSubscription(database, userId, "extend", 3, actor, 2, now, {
      endsAt: now + 60 * day,
    }),
    TypeError
  )
  assert.equal((await listSubscriptionAudit(database, userId)).length, 3)
})

test("overview includes all subscriptions and classifies expiration boundaries independently of user pages", async () => {
  const before = await getSubscriptionOverview(database, now)
  await set("user_overview_trial", { endsAt: now + 7 * day })
  await set("user_overview_standard", {
    type: "regular",
    endsAt: now + 8 * day,
  })
  await set("user_overview_expired", { endsAt: now }, now - day)
  await set("user_overview_revoked", { endsAt: now + day })
  await changeSubscription(
    database,
    "user_overview_revoked",
    "revoke",
    1,
    actor,
    undefined,
    now
  )
  const deviceId = "c".repeat(64)
  await database.batch([
    database
      .prepare(
        "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active) VALUES (?,'user_overview_standard','private-device-key',1,?,1)"
      )
      .bind(deviceId, now),
  ])
  const result = await getSubscriptionOverview(database, now)
  for (const [field, added] of Object.entries({
    totalSubscriptions: 4,
    active: 2,
    activeTrials: 1,
    activeStandard: 1,
    expired: 1,
    revoked: 1,
    expiringSoon: 1,
    assignedMacs: 1,
  }))
    assert.equal(result[field], before[field] + added, field)
  assert.equal(result.asOf, now)
  assert.equal(result.expiringWithinDays, 7)
  const subscription = await getSubscription(
    database,
    "user_overview_standard",
    now
  )
  assert.deepEqual(subscription.devices, [
    {
      id: deviceId,
      bindingRevision: 1,
      assignmentRevision: 1,
      activatedAt: now,
    },
  ])
  assert.equal(
    JSON.stringify(subscription).includes("private-device-key"),
    false
  )
})

test("canceling renewal preserves access and Mac assignments, guards concurrent changes and expires normally", async () => {
  const userId = "user_renewal_preference"
  const original = await set(userId, { type: "regular", endsAt: now + day })
  const outcomes = await Promise.allSettled([
    changeSubscriptionRenewal(
      database,
      userId,
      "cancel-renewal",
      1,
      actor,
      now + 1,
      "Customer request"
    ),
    changeSubscriptionRenewal(
      database,
      userId,
      "cancel-renewal",
      1,
      actor,
      now + 1,
      "Customer request"
    ),
  ])
  assert.equal(
    outcomes.filter(({ status }) => status === "fulfilled").length,
    1
  )
  assert.ok(
    outcomes.find(({ status }) => status === "rejected").reason instanceof
      SubscriptionConflictError
  )
  const canceled = await getSubscription(database, userId, now + 2)
  assert.deepEqual(canceled, {
    ...original,
    cancelAtPeriodEnd: true,
    canceledAt: now + 1,
    revision: 2,
    updatedAt: now + 1,
  })
  const overview = await getSubscriptionOverview(database, now + 2)
  assert.ok(overview.canceling >= 1)
  assert.equal(
    (await getSubscription(database, userId, original.endsAt)).status,
    "expired"
  )
  await assert.rejects(
    changeSubscriptionRenewal(
      database,
      userId,
      "resume-renewal",
      2,
      actor,
      original.endsAt
    ),
    TypeError
  )
  await assert.rejects(
    changeSubscriptionRenewal(
      database,
      userId,
      "resume-renewal",
      1,
      actor,
      now + 3
    ),
    SubscriptionConflictError
  )
  const resumed = await changeSubscriptionRenewal(
    database,
    userId,
    "resume-renewal",
    2,
    actor,
    now + 3
  )
  assert.equal(resumed.cancelAtPeriodEnd, false)
  assert.equal(resumed.canceledAt, null)
  assert.equal(resumed.endsAt, original.endsAt)
  assert.equal(resumed.bindingRevision, original.bindingRevision)
  assert.deepEqual(resumed.devices, original.devices)
  const audit = await listSubscriptionAudit(database, userId)
  assert.deepEqual(
    audit.map(({ action }) => action),
    ["resume-renewal", "cancel-renewal", "set"]
  )
  assert.equal(audit[1].reason, "Customer request")
})
