import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import {
  AccountRequestConflictError,
  AccountRequestLimitError,
  createAccountRequest,
  getAccountRequest,
  listAccountRequests,
  listAdminRequests,
  listRequestAudit,
  reviewAccountRequest,
  approveAccountRequest,
} from "../lib/account-requests.ts"
import {
  getSubscription,
  setSubscription,
  changeSubscription,
  listSubscriptionAudit,
} from "../lib/subscription-store.ts"

const now = 1_800_000_000_000
const owner = "owner@example.test"
const input = {
  userId: "user_request_customer",
  email: "customer@example.test",
  action: "renewal",
  message: "Please renew my account.",
}
let platform, database
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  database = platform.env.DB
  for (const filename of (
    await readdir(new URL("../migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
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
})
beforeEach(async () => {
  await database.batch(
    [
      "DELETE FROM subscription_request_audit",
      "DELETE FROM subscription_requests",
      "DELETE FROM subscription_audit",
      "DELETE FROM subscriptions",
    ].map((sql) => database.prepare(sql))
  )
})
after(async () => {
  await platform?.dispose()
})

test("concurrent retries create one active request and one creation audit", async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, () => createAccountRequest(database, input, now))
  )
  assert.equal(results.filter((result) => result.created).length, 1)
  assert.equal(new Set(results.map((result) => result.request.id)).size, 1)
  const id = results[0].request.id
  assert.equal((await listRequestAudit(database, id)).length, 1)
  await reviewAccountRequest(
    database,
    { id, action: "acknowledge", expectedRevision: 1, note: "Following up" },
    owner,
    now + 1
  )
  const retry = await createAccountRequest(
    database,
    { ...input, message: "Attempted duplicate update" },
    now + 2
  )
  assert.equal(retry.created, false)
  assert.equal(retry.request.message, input.message)
  assert.equal(retry.request.status, "acknowledged")
  assert.equal((await listAccountRequests(database, input.userId)).length, 1)
})

test("review actions use optimistic revisions and preserve an administrator-only audit", async () => {
  const { request } = await createAccountRequest(database, input, now)
  const acknowledged = await reviewAccountRequest(
    database,
    {
      id: request.id,
      action: "acknowledge",
      expectedRevision: 1,
      note: "Private admin note",
    },
    owner,
    now + 1
  )
  assert.equal(acknowledged.revision, 2)
  assert.equal(acknowledged.handledBy, owner)
  await assert.rejects(
    reviewAccountRequest(
      database,
      { id: request.id, action: "resolve", expectedRevision: 1 },
      owner,
      now + 2
    ),
    AccountRequestConflictError
  )
  assert.equal((await listRequestAudit(database, request.id)).length, 2)
  await reviewAccountRequest(
    database,
    {
      id: request.id,
      action: "resolve",
      expectedRevision: 2,
      note: "Access separately extended",
    },
    owner,
    now + 3
  )
  assert.equal(
    (await getAccountRequest(database, request.id)).status,
    "resolved"
  )
  await assert.rejects(
    reviewAccountRequest(
      database,
      { id: request.id, action: "reject", expectedRevision: 3 },
      owner,
      now + 4
    ),
    AccountRequestConflictError
  )
  const customer = (await listAccountRequests(database, input.userId))[0]
  assert.deepEqual(
    Object.keys(customer).sort(),
    [
      "action",
      "createdAt",
      "deviceId",
      "id",
      "message",
      "status",
      "updatedAt",
    ].sort()
  )
  assert.equal("adminNote" in customer, false)
  assert.equal("handledBy" in customer, false)
  assert.equal((await listAdminRequests(database)).openCount, 0)
  assert.equal(
    (await listAdminRequests(database, true)).requests[0].adminNote,
    "Access separately extended"
  )
  assert.equal((await listRequestAudit(database, request.id)).length, 3)
})

test("requests are isolated by account and selected Mac, with duplicates limited per target", async () => {
  const first = await createAccountRequest(
    database,
    {
      ...input,
      action: "reset-device",
      deviceId: "a".repeat(64),
      message: "<script>unsafe()</script>",
    },
    now
  )
  const second = await createAccountRequest(
    database,
    { ...input, action: "reset-device", deviceId: "b".repeat(64) },
    now + 1
  )
  const other = await createAccountRequest(
    database,
    { ...input, userId: "user_request_other", email: "other@example.test" },
    now + 2
  )
  assert.notEqual(first.request.id, second.request.id)
  assert.equal((await listAccountRequests(database, input.userId)).length, 2)
  assert.equal(
    (await listAccountRequests(database, "user_request_other"))[0].id,
    other.request.id
  )
  assert.equal(
    (await listAccountRequests(database, input.userId)).some(
      (request) => request.id === other.request.id
    ),
    false
  )
  assert.equal(first.request.message, "<script>unsafe()</script>")
  assert.equal((await listAdminRequests(database)).openCount, 3)
})

test("five new requests per rolling day are allowed; duplicates do not consume the limit", async () => {
  for (let index = 0; index < 5; index++) {
    const { request } = await createAccountRequest(database, input, now + index)
    if (index < 4)
      await reviewAccountRequest(
        database,
        { id: request.id, action: "reject", expectedRevision: 1 },
        owner,
        now + index
      )
  }
  const duplicate = await createAccountRequest(database, input, now + 10)
  assert.equal(duplicate.created, false)
  await assert.rejects(
    createAccountRequest(
      database,
      { ...input, action: "reset-device", deviceId: "c".repeat(64) },
      now + 11
    ),
    AccountRequestLimitError
  )
  assert.equal((await listAccountRequests(database, input.userId)).length, 5)
  const later = await createAccountRequest(
    database,
    { ...input, action: "reset-device", deviceId: "c".repeat(64) },
    now + 86_400_001
  )
  assert.equal(later.created, true)
})

test("validation rejects malformed targets, oversized text, and invalid review revisions", async () => {
  for (const invalid of [
    { ...input, message: "x".repeat(1001) },
    { ...input, userId: "not-a-user" },
    { ...input, deviceId: "a".repeat(64) },
    { ...input, action: "reset-device", deviceId: "invalid" },
  ])
    await assert.rejects(
      createAccountRequest(database, invalid, now),
      TypeError
    )
  const { request } = await createAccountRequest(database, input, now)
  for (const invalid of [
    { id: request.id, action: "resolve", expectedRevision: 0 },
    { id: request.id, action: "delete", expectedRevision: 1 },
    {
      id: request.id,
      action: "acknowledge",
      expectedRevision: 1,
      note: "x".repeat(1001),
    },
  ])
    await assert.rejects(
      reviewAccountRequest(database, invalid, owner, now + 1),
      TypeError
    )
  assert.equal((await getAccountRequest(database, request.id)).revision, 1)
  assert.equal((await listRequestAudit(database, request.id)).length, 1)
})

function approval(request, changes = {}) {
  return {
    id: request.id,
    expectedRevision: 1,
    expectedSubscriptionRevision: 0,
    type: "trial",
    endsAt: now + 86400000,
    note: "Owner approval",
    ...changes,
  }
}
test("approving an access request creates the chosen grant and both audits atomically", async () => {
  const { request } = await createAccountRequest(database, input, now)
  const result = await approveAccountRequest(
    database,
    approval(request),
    owner,
    now + 1
  )
  assert.equal(result.request.status, "resolved")
  assert.equal(result.request.revision, 2)
  assert.equal(result.subscription.type, "trial")
  assert.equal(result.subscription.endsAt, now + 86400000)
  assert.equal(result.subscription.revision, 1)
  assert.deepEqual(
    (await listRequestAudit(database, request.id)).map((row) => row.action),
    ["approve", "created"]
  )
  assert.equal((await listSubscriptionAudit(database, input.userId)).length, 1)
})
test("approval reactivates an existing revoked grant with explicit dates and preserves notes", async () => {
  const grant = await setSubscription(
    database,
    {
      userId: input.userId,
      type: "trial",
      endsAt: now + 1000,
      expectedRevision: 0,
      notes: "Preserve account notes",
    },
    owner,
    now
  )
  await changeSubscription(
    database,
    input.userId,
    "revoke",
    1,
    owner,
    undefined,
    now
  )
  const { request } = await createAccountRequest(database, input, now)
  const result = await approveAccountRequest(
    database,
    approval(request, { expectedSubscriptionRevision: 2, type: "regular" }),
    owner,
    now + 1
  )
  assert.equal(result.subscription.id, grant.id)
  assert.equal(result.subscription.status, "active")
  assert.equal(result.subscription.type, "regular")
  assert.equal(result.subscription.startsAt, now + 1)
  assert.equal(result.subscription.notes, grant.notes)
  assert.equal(result.subscription.revision, 3)
})
test("concurrent approvals allow one winner while stale request or grant revisions write neither half", async () => {
  const { request } = await createAccountRequest(database, input, now)
  await assert.rejects(
    approveAccountRequest(
      database,
      approval(request, { expectedRevision: 2 }),
      owner,
      now
    ),
    AccountRequestConflictError
  )
  assert.equal(await getSubscription(database, input.userId, now), null)
  assert.equal((await listRequestAudit(database, request.id)).length, 1)
  const outcomes = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      approveAccountRequest(database, approval(request), owner, now + 1)
    )
  )
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1
  )
  assert.equal((await listSubscriptionAudit(database, input.userId)).length, 1)
  assert.equal((await listRequestAudit(database, request.id)).length, 2)
  const next = await createAccountRequest(database, input, now + 2)
  await assert.rejects(
    approveAccountRequest(
      database,
      approval(next.request, { expectedSubscriptionRevision: 0 }),
      owner,
      now + 3
    ),
    AccountRequestConflictError
  )
  assert.equal(
    (await getAccountRequest(database, next.request.id)).status,
    "pending"
  )
  assert.equal((await getSubscription(database, input.userId, now)).revision, 1)
})
test("either audit failure rolls back the chosen grant and request resolution", async () => {
  const { request } = await createAccountRequest(database, input, now)
  for (const table of ["subscription_audit", "subscription_request_audit"]) {
    await database
      .prepare(
        `CREATE TRIGGER reject_approval_audit BEFORE INSERT ON ${table} WHEN NEW.actor='blocked@example.test' BEGIN SELECT RAISE(ABORT,'approval audit unavailable'); END`
      )
      .run()
    try {
      await assert.rejects(
        approveAccountRequest(
          database,
          approval(request),
          "blocked@example.test",
          now + 1
        ),
        /approval audit unavailable/
      )
      assert.equal(await getSubscription(database, input.userId, now), null)
      assert.equal(
        (await getAccountRequest(database, request.id)).status,
        "pending"
      )
      assert.equal((await listRequestAudit(database, request.id)).length, 1)
    } finally {
      await database.prepare("DROP TRIGGER reject_approval_audit").run()
    }
  }
})
