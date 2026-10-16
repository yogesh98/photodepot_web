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
import { LICENSE_GRACE_MS } from "../lib/license-crypto.ts"

const now = 1_800_000_000_000,
  day = 86_400_000,
  actor = "owner@example.test"
const billingConfig = {
  WORKOS_CLIENT_ID: "client_entitlement",
  WORKOS_COOKIE_PASSWORD: "test-workos-cookie-password-at-least-32-characters",
}
let platform, db, seeded
async function migrate(filename) {
  const sql = await readFile(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8"
  )
  await db.batch(unstable_splitSqlQuery(sql).map((sql) => db.prepare(sql)))
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
  { enabled = true, issuedAt = now, expiresAt = now + 300_000 } = {}
) {
  await db
    .prepare(
      "INSERT INTO stripe_customers (user_id,stripe_customer_id,workos_organization_id,customer_create_token) VALUES (?,?,?,?) ON CONFLICT(user_id) DO NOTHING"
    )
    .bind(userId, `cus_${userId}`, `org_${userId}`, `token_${userId}`)
    .run()
  await db
    .prepare(
      "INSERT INTO workos_billing_sessions (user_id,session_id,encrypted_tokens,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO NOTHING"
    )
    .bind(userId, `session_${userId}`, "unused-until-refresh", now)
    .run()
  await db
    .prepare(
      "INSERT INTO workos_entitlements (user_id,organization_id,enabled,issued_at,expires_at,revision,context) VALUES (?,?,?,?,?,1,?)"
    )
    .bind(
      userId,
      `org_${userId}`,
      enabled ? 1 : 0,
      issuedAt,
      expiresAt,
      JSON.stringify([billingConfig.WORKOS_CLIENT_ID, "photodepot-standard"])
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
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".sql") && n < "0015")
    .sort())
    await migrate(name)
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
  await migrate("0016_workos_entitlements.sql")
})
after(async () => {
  await platform?.dispose()
})

test("legacy manual history never authorizes; WorkOS activation and withdrawal preserve receipt identity", async () => {
  const initial = await getAccountEntitlement(db, seeded.userId, now)
  assert.equal(initial.grant, null)
  assert.equal(initial.access.canHost, false)
  const identity = await db
    .prepare("SELECT * FROM account_entitlements WHERE user_id=?")
    .bind(seeded.userId)
    .first()
  assert.equal(identity.id, seeded.id)
  await paid(seeded.userId)
  const purchased = await getAccountEntitlement(db, seeded.userId, now + 2)
  assert.equal(purchased.access.source, "workos")
  assert.equal(purchased.access.tier, "standard")
  assert.equal(purchased.billing, null)
  assert.equal(purchased.grant.id, seeded.id)
  assert.equal(purchased.grant.endsAt, now + LICENSE_GRACE_MS)
  assert.ok(purchased.grant.revision > identity.revision)
  await db
    .prepare(
      "UPDATE workos_entitlements SET enabled=0,revision=revision+1 WHERE user_id=?"
    )
    .bind(seeded.userId)
    .run()
  const fallback = await getAccountEntitlement(db, seeded.userId, now + 3)
  assert.equal(fallback.access.source, null)
  assert.equal(fallback.grant, null)
  const withdrawn = await db
    .prepare("SELECT * FROM account_entitlements WHERE user_id=?")
    .bind(seeded.userId)
    .first()
  assert.equal(withdrawn.id, seeded.id)
  assert.ok(withdrawn.revision > purchased.grant.revision)
  assert.equal(
    (await getSubscription(db, seeded.userId, now)).endsAt,
    seeded.endsAt
  )
  assert.deepEqual(
    (await listSubscriptionAudit(db, seeded.userId))
      .map((x) => x.action)
      .sort(),
    ["set", "update-notes"]
  )
})

test("expired, disabled and future WorkOS proof cannot mint a fresh offline allowance", async () => {
  for (const [suffix, options, status] of [
    ["expired", { expiresAt: now }, "expired"],
    ["disabled", { enabled: false }, "none"],
    ["future", { issuedAt: now + 1 }, "active"],
    [
      "old_lease",
      { issuedAt: now - LICENSE_GRACE_MS, expiresAt: now + day },
      "expired",
    ],
  ]) {
    const userId = `user_proof_${suffix}`
    await paid(userId, options)
    const result = await getAccountEntitlement(db, userId, now)
    assert.equal(result.access.canHost, false, suffix)
    assert.equal(result.access.status, status, suffix)
  }
  await paid("user_proof_deadline")
  const valid = await getAccountEntitlement(
    db,
    "user_proof_deadline",
    now + 299_999
  )
  const expired = await getAccountEntitlement(
    db,
    "user_proof_deadline",
    now + 300_000
  )
  assert.equal(valid.access.canHost, true)
  assert.equal(expired.access.canHost, false)
  assert.equal(expired.grant.endsAt, valid.grant.endsAt)
  assert.ok(expired.grant.revision > valid.grant.revision)
})

test("legacy Stripe ledger cannot grant access or inflate effective overview", async () => {
  const userId = "user_legacy_ledger"
  await db
    .prepare(
      "INSERT INTO stripe_customers (user_id,stripe_customer_id,customer_create_token) VALUES (?,?,?)"
    )
    .bind(userId, "cus_legacy", "legacy")
    .run()
  await db
    .prepare(
      "INSERT INTO stripe_subscriptions (id,user_id,customer_id,status,price_id,starts_at,access_ends_at,cancel_at_period_end,updated_at,revision) VALUES (?,?,?,'active','price_legacy',?,?,0,?,1)"
    )
    .bind("sub_legacy", userId, "cus_legacy", now, now + 30 * day, now)
    .run()
  const result = await getAccountEntitlement(db, userId, now)
  assert.equal(result.access.canHost, false)
  assert.equal(result.access.source, null)
  assert.equal(result.grant, null)
  const grant = await manual(userId)
  assert.equal(grant.status, "active")
  assert.equal((await getAccountEntitlement(db, userId, now)).grant, null)
})

test("manual deadlines never extend the WorkOS offline authorization allowance", async () => {
  await manual("user_later_manual", now + 3 * day)
  await paid("user_later_manual")
  assert.equal(
    (await getAccountEntitlement(db, "user_later_manual", now)).access.source,
    "workos"
  )
  await manual("user_equal_deadlines", now + LICENSE_GRACE_MS)
  await paid("user_equal_deadlines")
  assert.equal(
    (await getAccountEntitlement(db, "user_equal_deadlines", now)).access
      .source,
    "workos"
  )
})

test("desktop signs stable WorkOS receipts with fixed offline bounds and withdraws disabled proof", async () => {
  const userId = "user_signed_workos"
  await paid(userId)
  const vendor = generateKeyPairSync("ed25519"),
    sessionId = randomUUID()
  await db
    .prepare(
      "INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,active,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,1,?,?)"
    )
    .bind(
      sessionId,
      "device_workos",
      userId,
      "paid@example.test",
      "fixture-device-key",
      now,
      now
    )
    .run()
  const env = {
    ...platform.env,
    ...billingConfig,
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  }
  const row = await getDesktopSession(db, sessionId)
  const response = await desktopSessionResponse(
    env,
    row,
    "challenge_workos",
    now
  )
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
  assert.equal(receipt.subscriptionEndsAt, now + LICENSE_GRACE_MS)
  assert.equal(receipt.expiresAt, now + LICENSE_GRACE_MS)
  await db
    .prepare(
      "UPDATE workos_entitlements SET enabled=0,revision=revision+1 WHERE user_id=?"
    )
    .bind(userId)
    .run()
  const revoked = await desktopSessionResponse(
    env,
    row,
    "challenge_disabled",
    now + 1
  )
  assert.equal(revoked.receipt, undefined)
  assert.equal(
    JSON.parse(Buffer.from(revoked.session.payload, "base64url")).status,
    "active"
  )
})

test("production access ignores cached WorkOS proof without a usable dedicated session", async () => {
  const userId = "user_orphan_proof"
  await paid(userId)
  await db
    .prepare("DELETE FROM workos_billing_sessions WHERE user_id=?")
    .bind(userId)
    .run()
  assert.equal(
    (await getAccountEntitlement({ ...platform.env }, userId, now)).access
      .canHost,
    false
  )
  await manual(userId)
  assert.equal(
    (await getAccountEntitlement({ ...platform.env }, userId, now)).access
      .source,
    null
  )
})

test("snapshot races retry instead of signing a concurrently withdrawn WorkOS grant", async () => {
  const userId = "user_raced_entitlement"
  await paid(userId)
  await getAccountEntitlement(db, userId, now)
  let injected = false
  const racing = {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      const result = await db.batch(statements)
      if (!injected) {
        injected = true
        await db
          .prepare(
            "UPDATE workos_entitlements SET enabled=0,revision=revision+1 WHERE user_id=?"
          )
          .bind(userId)
          .run()
      }
      return result
    },
  }
  assert.equal(
    (await getAccountEntitlement(racing, userId, now)).access.canHost,
    false
  )
  const results = await Promise.all(
    Array.from({ length: 6 }, () => getAccountEntitlement(db, userId, now))
  )
  assert.ok(results.every((x) => x.grant === null))
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM account_entitlements WHERE user_id=?"
        )
        .bind(userId)
        .first()
    ).n,
    1
  )
})

test("stored manual and request history cannot override subscription authorization", async () => {
  const userId = "user_independent_manual"
  let grant = await manual(userId)
  await paid(userId)
  grant = await changeSubscription(
    db,
    userId,
    "extend",
    grant.revision,
    actor,
    1,
    now
  )
  grant = await changeSubscription(
    db,
    userId,
    "revoke",
    grant.revision,
    actor,
    undefined,
    now
  )
  assert.equal(
    (await getAccountEntitlement(db, userId, now)).access.source,
    "workos"
  )
  grant = await changeSubscription(
    db,
    userId,
    "restore",
    grant.revision,
    actor,
    undefined,
    now
  )
  grant = await updateSubscriptionNotes(
    db,
    userId,
    "Keep this note",
    grant.revision,
    actor,
    now
  )
  grant = await changeSubscriptionReminders(
    db,
    userId,
    false,
    grant.revision,
    actor,
    now
  )
  const request = await createAccountRequest(
    db,
    { userId, email: "paid@example.test", action: "renewal" },
    now
  )
  const result = await approveAccountRequest(
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
  )
  assert.equal(result.subscription.endsAt, now + 5 * day)
  assert.equal(
    (await getAccountRequest(db, request.request.id)).status,
    "resolved"
  )
  assert.equal(
    (await getAccountEntitlement(db, userId, now)).access.source,
    "workos"
  )
})

test("admin filters and overview include current WorkOS proof independently of manual rows", async () => {
  const userId = "user_directory_paid"
  await paid(userId)
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
      ...billingConfig,
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
    assert.equal(active.users[0].access.source, "workos")
    assert.equal(active.users[0].managed.enabled, true)
    assert.equal(
      (await listAdminUsers(env, new URLSearchParams("filter=expiring"), now))
        .users.length,
      0
    )
    assert.equal(
      (await listAdminUsers(env, new URLSearchParams("filter=standard"), now))
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
  const ids = (
    await db
      .prepare(
        "SELECT user_id FROM subscriptions UNION SELECT user_id FROM workos_entitlements"
      )
      .all()
  ).results
  const effective = (
    await Promise.all(ids.map((x) => getAccountEntitlement(db, x.user_id, now)))
  ).filter((x) => x.grant !== null)
  const overview = await getSubscriptionOverview(db, now)
  assert.equal(overview.totalSubscriptions, effective.length)
  for (const [field, filter] of [
    ["active", (x) => x.access.canHost],
    ["activeTrials", (x) => x.access.canHost && x.access.tier === "trial"],
    ["activeStandard", (x) => x.access.canHost && x.access.tier === "standard"],
    [
      "expiringSoon",
      (x) =>
        x.access.canHost &&
        x.access.source === "manual" &&
        x.access.endsAt <= now + 7 * day,
    ],
    ["expired", (x) => x.access.status === "expired"],
    ["revoked", (x) => x.access.status === "revoked"],
  ])
    assert.equal(overview[field], effective.filter(filter).length, field)
})

test("transient WorkOS failures fail closed even when a historical manual grant is valid", async () => {
  for (const suffix of ["manual", "paid_only"]) {
    const userId = `user_outage_${suffix}`
    await paid(userId, { expiresAt: now })
    if (suffix === "manual") await manual(userId)
    let unavailable = true
    const env = {
      ...platform.env,
      ...billingConfig,
      DB: {
        prepare(sql) {
          if (
            unavailable &&
            sql === "SELECT * FROM workos_entitlements WHERE user_id = ?"
          ) {
            unavailable = false
            throw new Error("Entitlement storage temporarily unavailable")
          }
          return db.prepare(sql)
        },
        batch: db.batch.bind(db),
      },
    }
    await assert.rejects(
      getAccountEntitlement(env, userId, now),
      /temporarily unavailable/
    )
    assert.equal(
      (
        await db
          .prepare(
            "SELECT reauth_needed FROM workos_billing_sessions WHERE user_id=?"
          )
          .bind(userId)
          .first()
      ).reauth_needed,
      0
    )
    assert.equal(
      (
        await db
          .prepare("SELECT expires_at FROM workos_entitlements WHERE user_id=?")
          .bind(userId)
          .first()
      ).expires_at,
      now
    )
  }
})

test("a proof issued during a slow refresh is evaluated using the advanced request clock", async () => {
  const userId = "user_refresh_clock"
  await paid(userId)
  let shifted = false
  const delayed = {
    ...platform.env,
    ...billingConfig,
    DB: {
      prepare: db.prepare.bind(db),
      async batch(statements) {
        if (!shifted) {
          shifted = true
          await new Promise((resolve) => setTimeout(resolve, 40))
          await db
            .prepare(
              "UPDATE workos_entitlements SET issued_at=?,revision=revision+1 WHERE user_id=?"
            )
            .bind(now + 20, userId)
            .run()
        }
        return db.batch(statements)
      },
    },
  }
  const result = await getAccountEntitlement(delayed, userId, now)
  assert.equal(result.access.canHost, true)
  assert.equal(result.grant.startsAt, now + 20)
})

test("connecting WorkOS before a purchase stays free and disabled proof preserves existing receipt identity", async () => {
  const userId = "user_connected_without_purchase"
  await paid(userId, { enabled: false })
  const free = await getAccountEntitlement(db, userId, now)
  assert.equal(free.access.tier, "free")
  assert.equal(free.access.source, null)
  assert.equal(free.access.status, "none")
  assert.equal(free.access.startsAt, null)
  assert.equal(free.access.endsAt, null)
  assert.equal(free.grant, null)
  assert.equal(
    await db
      .prepare("SELECT id FROM account_entitlements WHERE user_id=?")
      .bind(userId)
      .first(),
    null
  )
  await db
    .prepare(
      "UPDATE workos_entitlements SET enabled=1,revision=revision+1 WHERE user_id=?"
    )
    .bind(userId)
    .run()
  const purchased = await getAccountEntitlement(db, userId, now)
  await db
    .prepare(
      "UPDATE workos_entitlements SET enabled=0,revision=revision+1 WHERE user_id=?"
    )
    .bind(userId)
    .run()
  const disabled = await getAccountEntitlement(db, userId, now)
  assert.equal(disabled.grant, null)
  assert.equal(disabled.access.source, null)
  const projection = await db
    .prepare("SELECT id,revision FROM account_entitlements WHERE user_id=?")
    .bind(userId)
    .first()
  assert.equal(projection.id, purchased.grant.id)
  assert.ok(projection.revision > purchased.grant.revision)
  await db
    .prepare(
      "UPDATE workos_entitlements SET enabled=1,revision=revision+1 WHERE user_id=?"
    )
    .bind(userId)
    .run()
  assert.equal(
    (await getAccountEntitlement(db, userId, now)).grant.id,
    purchased.grant.id
  )
})
