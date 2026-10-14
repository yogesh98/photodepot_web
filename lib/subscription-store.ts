import { randomUUID } from "node:crypto"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type {
  SubscriptionAudit,
  SubscriptionSummary,
  SubscriptionType,
} from "./subscription-types.ts"

const millisecondsPerDay = 24 * 60 * 60 * 1000
const maximumTimestamp = 8_640_000_000_000_000

interface SubscriptionRow {
  id: string
  user_id: string
  type: SubscriptionType
  status: "active" | "revoked"
  started_at: number
  end_at: number
  updated_at: number
  revision: number
}

export class SubscriptionConflictError extends Error {
  constructor() {
    super("The subscription changed. Refresh and try again.")
    this.name = "SubscriptionConflictError"
  }
}

function validateUserId(userId: string) {
  if (
    typeof userId !== "string" ||
    userId.length > 128 ||
    !/^user_[A-Za-z0-9_]+$/.test(userId)
  )
    throw new TypeError("Invalid WorkOS user.")
}

function validateTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximumTimestamp)
    throw new TypeError("Invalid subscription date.")
}

function validateMutation(
  userId: string,
  expectedRevision: number,
  actor: string,
  now: number
) {
  validateUserId(userId)
  validateTimestamp(now)
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    throw new TypeError("Invalid subscription revision.")
  if (typeof actor !== "string" || !actor.trim() || actor.length > 320)
    throw new TypeError("Invalid subscription administrator.")
}

function summary(row: SubscriptionRow, now: number): SubscriptionSummary {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    status:
      row.status === "revoked"
        ? "revoked"
        : now >= row.end_at
          ? "expired"
          : "active",
    startsAt: row.started_at,
    endsAt: row.end_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  }
}

export async function listSubscriptions(
  database: D1Database,
  userIds: string[],
  now = Date.now()
): Promise<Map<string, SubscriptionSummary>> {
  validateTimestamp(now)
  const uniqueIds = [...new Set(userIds)]
  uniqueIds.forEach(validateUserId)
  const subscriptions = new Map<string, SubscriptionSummary>()
  // Stay below D1's bound-parameter limit even when a user page grows.
  for (let offset = 0; offset < uniqueIds.length; offset += 90) {
    const batch = uniqueIds.slice(offset, offset + 90)
    const rows = await database
      .prepare(
        `SELECT * FROM subscriptions WHERE user_id IN (${batch.map(() => "?").join(", ")})`
      )
      .bind(...batch)
      .all<SubscriptionRow>()
    for (const row of rows.results)
      subscriptions.set(row.user_id, summary(row, now))
  }
  return subscriptions
}

export async function getSubscription(
  database: D1Database,
  userId: string,
  now = Date.now()
): Promise<SubscriptionSummary | null> {
  validateUserId(userId)
  validateTimestamp(now)
  const row = await database
    .prepare("SELECT * FROM subscriptions WHERE user_id = ?")
    .bind(userId)
    .first<SubscriptionRow>()
  return row ? summary(row, now) : null
}

async function mutateWithAudit(
  database: D1Database,
  mutation: D1PreparedStatement,
  userId: string,
  expectedRevision: number,
  action: "set" | "revoke" | "restore" | "extend",
  actor: string,
  detail: string,
  now: number
): Promise<SubscriptionSummary> {
  // D1 executes a batch as one transaction. changes() observes the immediately
  // preceding conditional mutation, so conflicts cannot create audit records.
  const results = await database.batch<SubscriptionRow>([
    mutation,
    database
      .prepare(
        `INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail)
         SELECT ?, id, ?, ?, ?, ? FROM subscriptions
         WHERE user_id = ? AND revision = ? AND changes() = 1`
      )
      .bind(
        randomUUID(),
        action,
        actor,
        now,
        detail,
        userId,
        expectedRevision + 1
      ),
  ])
  const row = results[0].results[0]
  if (!row) throw new SubscriptionConflictError()
  return summary(row, now)
}

export async function setSubscription(
  database: D1Database,
  values: {
    userId: string
    type: SubscriptionType
    endsAt: number
    expectedRevision: number
  },
  actor: string,
  now = Date.now()
): Promise<SubscriptionSummary> {
  const { userId, type, endsAt, expectedRevision } = values
  validateMutation(userId, expectedRevision, actor, now)
  validateTimestamp(endsAt)
  if ((type !== "trial" && type !== "regular") || endsAt <= now)
    throw new TypeError("Choose a subscription type and future expiration.")
  const mutation =
    expectedRevision === 0
      ? database
          .prepare(
            `INSERT INTO subscriptions (id, user_id, type, status, started_at, end_at, updated_at, revision)
             VALUES (?, ?, ?, 'active', ?, ?, ?, 1)
             ON CONFLICT(user_id) DO NOTHING RETURNING *`
          )
          .bind(randomUUID(), userId, type, now, endsAt, now)
      : database
          .prepare(
            `UPDATE subscriptions SET type = ?, status = 'active', started_at = ?,
             end_at = ?, updated_at = ?, revision = revision + 1
             WHERE user_id = ? AND revision = ? RETURNING *`
          )
          .bind(type, now, endsAt, now, userId, expectedRevision)
  return mutateWithAudit(
    database,
    mutation,
    userId,
    expectedRevision,
    "set",
    actor,
    `Set ${type} access until ${new Date(endsAt).toISOString()}`,
    now
  )
}

export async function changeSubscription(
  database: D1Database,
  userId: string,
  action: "revoke" | "restore" | "extend",
  expectedRevision: number,
  actor: string,
  durationDays?: number,
  now = Date.now()
): Promise<SubscriptionSummary> {
  validateMutation(userId, expectedRevision, actor, now)
  if (!["revoke", "restore", "extend"].includes(action))
    throw new TypeError("Invalid subscription action.")
  let mutation: D1PreparedStatement
  let detail: string
  if (action === "extend") {
    if (
      !Number.isSafeInteger(durationDays) ||
      !durationDays ||
      durationDays < 1 ||
      !Number.isSafeInteger(durationDays * millisecondsPerDay) ||
      durationDays * millisecondsPerDay > maximumTimestamp - now
    )
      throw new TypeError("Enter a positive whole number of days.")
    const duration = durationDays * millisecondsPerDay
    mutation = database
      .prepare(
        `UPDATE subscriptions SET end_at = MAX(end_at, ?) + ?, updated_at = ?,
         revision = revision + 1 WHERE user_id = ? AND revision = ?
         AND MAX(end_at, ?) <= ? RETURNING *`
      )
      .bind(
        now,
        duration,
        now,
        userId,
        expectedRevision,
        now,
        maximumTimestamp - duration
      )
    detail = `Extended access by ${durationDays} ${durationDays === 1 ? "day" : "days"}`
  } else {
    mutation = database
      .prepare(
        `UPDATE subscriptions SET status = ?, updated_at = ?, revision = revision + 1
         WHERE user_id = ? AND revision = ? RETURNING *`
      )
      .bind(
        action === "revoke" ? "revoked" : "active",
        now,
        userId,
        expectedRevision
      )
    detail = action === "revoke" ? "Revoked access" : "Restored access"
  }
  return mutateWithAudit(
    database,
    mutation,
    userId,
    expectedRevision,
    action,
    actor,
    detail,
    now
  )
}

export async function listSubscriptionAudit(
  database: D1Database,
  userId: string
): Promise<SubscriptionAudit[]> {
  validateUserId(userId)
  const rows = await database
    .prepare(
      `SELECT a.id, a.action, a.actor, a.created_at AS createdAt, a.detail
       FROM subscription_audit a JOIN subscriptions s ON s.id = a.subscription_id
       WHERE s.user_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 100`
    )
    .bind(userId)
    .all<SubscriptionAudit>()
  return rows.results
}
