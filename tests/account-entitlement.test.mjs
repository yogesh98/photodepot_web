import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID, verify } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { getAccountEntitlement } from "../lib/account-entitlement.ts"
import {
  desktopSessionResponse,
  getDesktopSession,
} from "../lib/account-sessions.ts"
import { listAdminUsers } from "../lib/admin-directory.ts"
import {
  approveAccountRequest,
  createAccountRequest,
  getAccountRequest,
} from "../lib/account-requests.ts"
import {
  changeSubscription,
  changeSubscriptionReminders,
  getSubscription,
  getSubscriptionOverview,
  listSubscriptionAudit,
  setSubscription,
  updateSubscriptionNotes,
} from "../lib/subscription-store.ts"

const now = 1_800_000_000_000
const day = 86_400_000
const actor = "owner@example.test"
let platform, db, seeded
async function migrate(filename) {
  const source = await readFile(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8"
  )
  await db.batch(unstable_splitSqlQuery(source).map((sql) => db.prepare(sql)))
}
function manual(userId, endsAt = now + day) {
  return setSubscription(
    db,
    { userId, type: "regular", endsAt, expectedRevision: 0 },
    actor,
    now
  )
}
async function paid(
  userId,
  {
    status = "active",
    endsAt = now + 2 * day,
    startsAt = now,
    id = `sub_${userId}`,
  } = {}
) {
  await db
    .prepare(
      "INSERT INTO stripe_customers (user_id,stripe_customer_id,customer_create_token) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING"
    )
    .bind(userId, `cus_${userId}`, `token_${userId}`)
    .run()
  await db
    .prepare(
      "INSERT INTO stripe_subscriptions (id,user_id,customer_id,status,price_id,starts_at,access_ends_at,cancel_at_period_end,updated_at,revision) VALUES (?,?,?,?,?,?,?,0,?,1)"
    )
    .bind(
      id,
      userId,
      `cus_${userId}`,
      status,
      "price_fixture",
      startsAt,
      endsAt,
      now
    )
    .run()
}
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  db = platform.env.DB
  for (const filename of (
    await readdir(new URL("../migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql") && name < "0015")
    .sort())
    await migrate(filename)
  seeded = await manual("user_seeded_receipt")
  seeded = await updateSubscriptionNotes(
    db,
    seeded.userId,
    "Existing history",
    seeded.revision,
    actor,
    now
  )
  await migrate("0015_account_entitlements.sql")
})
after(async () => {
  await platform?.dispose()
})

test("migration and manual→paid→manual transitions preserve receipt identity and monotonic revision", async () => {
  const initial = await getAccountEntitlement(db, seeded.userId, now)
  assert.equal(initial.grant.id, seeded.id)
  assert.ok(initial.grant.revision >= seeded.revision)
  const repeated = await getAccountEntitlement(db, seeded.userId, now + 1)
  assert.equal(repeated.grant.revision, initial.grant.revision)
  await paid(seeded.userId)
  const purchased = await getAccountEntitlement(db, seeded.userId, now + 2)
  assert.equal(purchased.access.source, "stripe")
  assert.equal(purchased.grant.id, initial.grant.id)
  assert.ok(purchased.grant.revision > initial.grant.revision)
  await db
    .prepare(
      "UPDATE stripe_subscriptions SET status='canceled',revision=revision+1 WHERE user_id=?"
    )
    .bind(seeded.userId)
    .run()
  const fallback = await getAccountEntitlement(db, seeded.userId, now + 3)
  assert.equal(fallback.access.source, "manual")
  assert.equal(fallback.grant.id, initial.grant.id)
  assert.ok(fallback.grant.revision > purchased.grant.revision)
  assert.equal(
    (await getSubscription(db, seeded.userId, now)).endsAt,
    seeded.endsAt
  )
  assert.deepEqual(
    (await listSubscriptionAudit(db, seeded.userId))
      .map((entry) => entry.action)
      .sort(),
    ["set", "update-notes"]
  )
})

test("confirmed term expiry, canceled/deleted, unpaid, paused and incomplete billing never grant access", async () => {
  for (const status of [
    "canceled",
    "unpaid",
    "paused",
    "incomplete",
    "incomplete_expired",
  ]) {
    const userId = `user_denied_${status}`
    await paid(userId, { status })
    const result = await getAccountEntitlement(db, userId, now)
    assert.equal(result.access.canUseLocal, false, status)
    assert.equal(result.access.source, "stripe")
  }
  const userId = "user_confirmed_deadline"
  await paid(userId, { status: "past_due", endsAt: now + day })
  const before = await getAccountEntitlement(db, userId, now + day - 1)
  const ended = await getAccountEntitlement(db, userId, now + day)
  assert.equal(before.access.canHost, true)
  assert.equal(ended.access.canHost, false)
  assert.equal(ended.access.status, "expired")
  assert.equal(ended.grant.id, before.grant.id)
  assert.ok(ended.grant.revision > before.grant.revision)
})

test("later valid manual deadline wins; Stripe wins ties and future starts do not authorize", async () => {
  await manual("user_later_manual", now + 3 * day)
  await paid("user_later_manual", { endsAt: now + 2 * day })
  assert.equal(
    (await getAccountEntitlement(db, "user_later_manual", now)).access.source,
    "manual"
  )
  await manual("user_equal_deadlines", now + day)
  await paid("user_equal_deadlines", { endsAt: now + day })
  assert.equal(
    (await getAccountEntitlement(db, "user_equal_deadlines", now)).access
      .source,
    "stripe"
  )
  await paid("user_future_paid", { startsAt: now + day })
  assert.equal(
    (await getAccountEntitlement(db, "user_future_paid", now)).access.canHost,
    false
  )
})

test("desktop signs the same stable paid entitlement, bounds its offline deadline and withdraws it after cancellation", async () => {
  const userId = "user_signed_paid"
  await paid(userId, { endsAt: now + day })
  const vendor = generateKeyPairSync("ed25519")
  const sessionId = randomUUID()
  await db
    .prepare(
      "INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)"
    )
    .bind(
      sessionId,
      "device_paid",
      userId,
      "paid@example.test",
      "fixture-device-key",
      now,
      now
    )
    .run()
  const env = {
    ...platform.env,
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  }
  const row = await getDesktopSession(db, sessionId)
  const response = await desktopSessionResponse(env, row, "challenge_paid", now)
  const grant = await getAccountEntitlement(db, userId, now)
  const receipt = JSON.parse(Buffer.from(response.receipt.payload, "base64url"))
  assert.equal(
    verify(
      null,
      Buffer.from(response.receipt.payload, "base64url"),
      vendor.publicKey,
      Buffer.from(response.receipt.signature, "base64url")
    ),
    true
  )
  assert.equal(receipt.licenseId, grant.grant.id)
  assert.equal(receipt.revision, grant.grant.revision)
  assert.equal(receipt.subscriptionEndsAt, now + day)
  assert.equal(receipt.expiresAt, now + day)
  assert.equal(receipt.type, "regular")
  await db
    .prepare(
      "UPDATE stripe_subscriptions SET status='canceled',revision=revision+1 WHERE user_id=?"
    )
    .bind(userId)
    .run()
  const canceled = await desktopSessionResponse(
    env,
    row,
    "challenge_canceled",
    now + 1
  )
  assert.equal(canceled.receipt, undefined)
  assert.equal(
    JSON.parse(Buffer.from(canceled.session.payload, "base64url")).status,
    "active"
  )
})

test("snapshot races retry instead of signing a concurrently canceled paid grant", async () => {
  const userId = "user_raced_entitlement"
  await paid(userId)
  await getAccountEntitlement(db, userId, now)
  let injected = false
  const racingDatabase = {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      const snapshot = await db.batch(statements)
      if (!injected) {
        injected = true
        await db
          .prepare(
            "UPDATE stripe_subscriptions SET status='canceled',revision=revision+1 WHERE user_id=?"
          )
          .bind(userId)
          .run()
      }
      return snapshot
    },
  }
  assert.equal(
    (await getAccountEntitlement(racingDatabase, userId, now)).access.canHost,
    false
  )
  const results = await Promise.all(
    Array.from({ length: 6 }, () => getAccountEntitlement(db, userId, now))
  )
  assert.equal(new Set(results.map((result) => result.grant.id)).size, 1)
  assert.equal(new Set(results.map((result) => result.grant.revision)).size, 1)
})

test("nonterminal billing guards every manual grant/approval write without changing audits; preferences remain editable", async () => {
  const userId = "user_guarded_paid"
  const grant = await manual(userId)
  const request = await createAccountRequest(
    db,
    { userId, email: "paid@example.test", action: "renewal" },
    now
  )
  await paid(userId)
  const audits = await listSubscriptionAudit(db, userId)
  const blocked =
    /Manage its paid access and charge dates through Stripe billing/
  await assert.rejects(
    setSubscription(
      db,
      {
        userId,
        type: "trial",
        endsAt: now + 4 * day,
        expectedRevision: grant.revision,
      },
      actor,
      now
    ),
    blocked
  )
  for (const action of ["extend", "revoke", "restore"])
    await assert.rejects(
      changeSubscription(db, userId, action, grant.revision, actor, 1, now),
      blocked
    )
  await assert.rejects(
    approveAccountRequest(
      db,
      {
        id: request.request.id,
        expectedRevision: 1,
        expectedSubscriptionRevision: grant.revision,
        type: "regular",
        endsAt: now + 5 * day,
      },
      actor,
      now
    ),
    blocked
  )
  assert.deepEqual(await listSubscriptionAudit(db, userId), audits)
  assert.equal(
    (await getAccountRequest(db, request.request.id)).status,
    "pending"
  )
  const notes = await updateSubscriptionNotes(
    db,
    userId,
    "Keep this note",
    grant.revision,
    actor,
    now
  )
  const reminders = await changeSubscriptionReminders(
    db,
    userId,
    false,
    notes.revision,
    actor,
    now
  )
  assert.equal(reminders.remindersEnabled, false)
  await db
    .prepare(
      "UPDATE stripe_subscriptions SET status='canceled',revision=revision+1 WHERE user_id=?"
    )
    .bind(userId)
    .run()
  const extended = await changeSubscription(
    db,
    userId,
    "extend",
    reminders.revision,
    actor,
    1,
    now
  )
  assert.equal(extended.endsAt, grant.endsAt + day)
})

test("admin filters and overview include paid-only accounts using effective access", async () => {
  const userId = "user_directory_paid"
  await paid(userId, { status: "trialing" })
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({
      data: [
        {
          object: "user",
          id: userId,
          email: "paid@example.test",
          email_verified: true,
          first_name: "Paid",
          last_name: "Customer",
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
        },
      ],
      list_metadata: { before: null, after: null },
    })
  try {
    const env = {
      ...platform.env,
      WORKOS_CLIENT_ID: "client_entitlement",
      WORKOS_API_KEY: "sk_test_fixture",
    }
    const active = await listAdminUsers(
      env,
      new URLSearchParams("filter=active"),
      now
    )
    assert.equal(active.users.length, 1)
    assert.equal(active.users[0].subscription, null)
    assert.equal(active.users[0].access.source, "stripe")
    assert.equal(active.users[0].billing.status, "trialing")
    assert.equal(
      (await listAdminUsers(env, new URLSearchParams("filter=trial"), now))
        .users.length,
      1
    )
    assert.equal(
      (await listAdminUsers(env, new URLSearchParams("filter=unassigned"), now))
        .users.length,
      0
    )
  } finally {
    globalThis.fetch = original
  }
  const userIds = (
    await db
      .prepare(
        "SELECT user_id FROM subscriptions UNION SELECT user_id FROM stripe_subscriptions"
      )
      .all()
  ).results
  const effective = await Promise.all(
    userIds.map((row) => getAccountEntitlement(db, row.user_id, now))
  )
  const overview = await getSubscriptionOverview(db, now)
  assert.equal(overview.totalSubscriptions, effective.length)
  assert.equal(
    overview.active,
    effective.filter((row) => row.access.canHost).length
  )
  assert.equal(
    overview.activeTrials,
    effective.filter((row) => row.access.canHost && row.access.tier === "trial")
      .length
  )
  assert.equal(
    overview.expired,
    effective.filter((row) => row.access.status === "expired").length
  )
  assert.equal(
    overview.revoked,
    effective.filter((row) => row.access.status === "revoked").length
  )
})
