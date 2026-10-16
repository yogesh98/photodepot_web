import { randomUUID } from "node:crypto"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import type {
  SubscriptionAudit,
  SubscriptionOverview,
  SubscriptionSummary,
  SubscriptionType,
} from "./subscription-types.ts"

const millisecondsPerDay = 24 * 60 * 60 * 1000
const maximumTimestamp = 8_640_000_000_000_000
export const SUBSCRIPTION_EXPIRING_DAYS = 7

export interface SubscriptionRow {
  id: string
  user_id: string
  type: SubscriptionType
  status: "active" | "revoked"
  started_at: number
  end_at: number
  updated_at: number
  revision: number
  notes: string
  reminder_opt_out_at?: number | null
}

export class SubscriptionConflictError extends Error {
  constructor() {
    super("The subscription changed. Refresh and try again.")
    this.name = "SubscriptionConflictError"
  }
}

export const manualAccessGuard =
  "NOT EXISTS (SELECT 1 FROM stripe_subscriptions WHERE user_id = ? AND status NOT IN ('canceled','incomplete_expired'))"

export async function assertManualAccessAllowed(
  database: D1Database,
  userId: string
) {
  const paid = await database
    .prepare(
      "SELECT id FROM stripe_subscriptions WHERE user_id = ? AND status NOT IN ('canceled','incomplete_expired') LIMIT 1"
    )
    .bind(userId)
    .first()
  if (paid) {
    const error = new SubscriptionConflictError()
    error.message =
      "This account has a Stripe subscription. Manage its paid access and charge dates through Stripe billing."
    throw error
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

export function subscriptionReason(value: unknown = ""): string {
  if (typeof value !== "string" || value.length > 1000)
    throw new TypeError(
      "Enter an administrator reason of at most 1,000 characters."
    )
  return value.trim()
}

function subscriptionNotes(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000)
    throw new TypeError(
      "Enter administrator notes of at most 2,000 characters."
    )
  return value.trim()
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

export function subscriptionSummary(
  row: SubscriptionRow,
  now: number
): SubscriptionSummary {
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
    notes: row.notes,
    remindersEnabled: row.reminder_opt_out_at == null,
  }
}

export const subscriptionSelectFields =
  "s.id,s.user_id,s.type,s.status,s.started_at,s.end_at,s.updated_at,s.revision,s.notes,s.reminder_opt_out_at"
export const subscriptionQuery = `SELECT ${subscriptionSelectFields} FROM subscriptions s`

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
        `${subscriptionQuery} WHERE s.user_id IN (${batch.map(() => "?").join(", ")})`
      )
      .bind(...batch)
      .all<SubscriptionRow>()
    for (const row of rows.results)
      subscriptions.set(row.user_id, subscriptionSummary(row, now))
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
    .prepare(`${subscriptionQuery} WHERE s.user_id = ?`)
    .bind(userId)
    .first<SubscriptionRow>()
  return row ? subscriptionSummary(row, now) : null
}

/** Counts the entire deployment database, independently of WorkOS pagination. */
export async function getSubscriptionOverview(
  database: D1Database,
  now = Date.now()
): Promise<SubscriptionOverview> {
  validateTimestamp(now)
  const expiringAt = Math.min(
    maximumTimestamp,
    now + SUBSCRIPTION_EXPIRING_DAYS * millisecondsPerDay
  )
  const row = await database
    .prepare(
      `WITH ranked_paid AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY
           CASE WHEN status NOT IN ('canceled','incomplete_expired') THEN 0 ELSE 1 END,
           starts_at DESC,id DESC) AS rank FROM stripe_subscriptions
       ), users AS (
         SELECT user_id FROM subscriptions UNION SELECT user_id FROM stripe_subscriptions
       ), candidates AS (
         SELECT m.id AS manual_id,m.type AS manual_type,m.end_at AS manual_end,
           CASE WHEN m.status='revoked' THEN 'revoked' WHEN m.end_at<=? THEN 'expired' ELSE 'active' END AS manual_status,
           (m.status='active' AND m.started_at<=? AND m.end_at>?) AS manual_valid,
           p.id AS paid_id,p.access_ends_at AS paid_end,
           CASE WHEN p.status='trialing' THEN 'trial' ELSE 'regular' END AS paid_type,
           CASE WHEN p.status NOT IN ('active','trialing','past_due') THEN 'revoked' WHEN p.access_ends_at<=? THEN 'expired' ELSE 'active' END AS paid_status,
           (p.status IN ('active','trialing','past_due') AND p.starts_at<=? AND p.access_ends_at>?) AS paid_valid
         FROM users u LEFT JOIN subscriptions m ON m.user_id=u.user_id
         LEFT JOIN ranked_paid p ON p.user_id=u.user_id AND p.rank=1
       ), choices AS (
         SELECT *, CASE WHEN paid_valid AND (NOT COALESCE(manual_valid,0) OR paid_end>=manual_end)
           THEN 1 WHEN manual_id IS NOT NULL THEN 0 ELSE 1 END AS choose_paid FROM candidates
       ), effective AS (
         SELECT CASE WHEN choose_paid THEN paid_type ELSE manual_type END AS type,
           CASE WHEN choose_paid THEN paid_end ELSE manual_end END AS end_at,
           CASE WHEN choose_paid THEN paid_status ELSE manual_status END AS status,
           CASE WHEN choose_paid THEN paid_valid ELSE manual_valid END AS valid FROM choices
       ) SELECT COUNT(*) AS totalSubscriptions,
       COALESCE(SUM(valid), 0) AS active,
       COALESCE(SUM(valid AND type = 'trial'), 0) AS activeTrials,
       COALESCE(SUM(valid AND type = 'regular'), 0) AS activeStandard,
       COALESCE(SUM(status = 'expired'), 0) AS expired,
       COALESCE(SUM(status = 'revoked'), 0) AS revoked,
       COALESCE(SUM(valid AND end_at <= ?), 0) AS expiringSoon,
       (SELECT COUNT(*) FROM waitlist) AS waitlistTotal,
       (SELECT COUNT(*) FROM waitlist WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)) AS waitlistLast30Days,
       (SELECT COUNT(*) FROM subscription_requests WHERE status IN ('pending', 'acknowledged')) AS openRequests,
       (SELECT COUNT(*) FROM desktop_sessions WHERE active = 1) AS assignedMacs
       FROM effective`
    )
    .bind(
      now,
      now,
      now,
      now,
      now,
      now,
      expiringAt,
      new Date(Math.max(0, now - 30 * millisecondsPerDay)).toISOString(),
      new Date(now).toISOString()
    )
    .first<Omit<SubscriptionOverview, "asOf" | "expiringWithinDays">>()
  if (!row) throw new Error("Subscription overview is unavailable")
  return { ...row, asOf: now, expiringWithinDays: SUBSCRIPTION_EXPIRING_DAYS }
}

async function mutateWithAudit(
  database: D1Database,
  mutation: D1PreparedStatement,
  userId: string,
  expectedRevision: number,
  action:
    "set" | "revoke" | "restore" | "extend" | "update-notes" | "set-reminders",
  actor: string,
  detail: string,
  reason: string,
  now: number,
  requiresManualAccess = false
): Promise<SubscriptionSummary> {
  // D1 executes a batch as one transaction. changes() observes the immediately
  // preceding conditional mutation, so conflicts cannot create audit records.
  const results = await database.batch<SubscriptionRow>([
    mutation,
    database
      .prepare(
        `INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail, reason)
         SELECT ?, id, ?, ?, ?, ?, ? FROM subscriptions
         WHERE user_id = ? AND revision = ? AND changes() = 1`
      )
      .bind(
        randomUUID(),
        action,
        actor,
        now,
        detail,
        reason,
        userId,
        expectedRevision + 1
      ),
    database.prepare(`${subscriptionQuery} WHERE s.user_id = ?`).bind(userId),
  ])
  if (!results[0].results[0]) {
    if (requiresManualAccess) await assertManualAccessAllowed(database, userId)
    throw new SubscriptionConflictError()
  }
  const row = results[2].results[0]
  if (!row) throw new Error("Updated subscription is unavailable")
  return subscriptionSummary(row, now)
}

export async function setSubscription(
  database: D1Database,
  values: {
    userId: string
    type: SubscriptionType
    endsAt: number
    expectedRevision: number
    notes?: string
    reason?: string
  },
  actor: string,
  now = Date.now()
): Promise<SubscriptionSummary> {
  const { userId, type, endsAt, expectedRevision } = values
  validateMutation(userId, expectedRevision, actor, now)
  validateTimestamp(endsAt)
  const reason = subscriptionReason(values.reason)
  const notes =
    values.notes === undefined ? null : subscriptionNotes(values.notes)
  if ((type !== "trial" && type !== "regular") || endsAt <= now)
    throw new TypeError("Choose a subscription type and future expiration.")
  await assertManualAccessAllowed(database, userId)
  const mutation =
    expectedRevision === 0
      ? database
          .prepare(
            `INSERT INTO subscriptions (id, user_id, type, status, started_at, end_at, updated_at, revision, notes)
             SELECT ?, ?, ?, 'active', ?, ?, ?, 1, ? WHERE ${manualAccessGuard}
             ON CONFLICT(user_id) DO NOTHING RETURNING *`
          )
          .bind(
            randomUUID(),
            userId,
            type,
            now,
            endsAt,
            now,
            notes ?? "",
            userId
          )
      : database
          .prepare(
            `UPDATE subscriptions SET type = ?, status = 'active', started_at = ?,
             end_at = ?, updated_at = ?, revision = revision + 1, notes = COALESCE(?, notes)
             WHERE user_id = ? AND revision = ? AND ${manualAccessGuard} RETURNING *`
          )
          .bind(type, now, endsAt, now, notes, userId, expectedRevision, userId)
  return mutateWithAudit(
    database,
    mutation,
    userId,
    expectedRevision,
    "set",
    actor,
    `Set ${type} access until ${new Date(endsAt).toISOString()}${notes !== null ? ` / Notes: ${notes || "(cleared)"}` : ""}`,
    reason,
    now,
    true
  )
}

export async function changeSubscription(
  database: D1Database,
  userId: string,
  action: "revoke" | "restore" | "extend",
  expectedRevision: number,
  actor: string,
  durationDays?: number,
  now = Date.now(),
  options: { reason?: string; endsAt?: number } = {}
): Promise<SubscriptionSummary> {
  validateMutation(userId, expectedRevision, actor, now)
  const reason = subscriptionReason(options.reason)
  if (!["revoke", "restore", "extend"].includes(action))
    throw new TypeError("Invalid subscription action.")
  await assertManualAccessAllowed(database, userId)
  let mutation: D1PreparedStatement
  let detail: string
  if (action === "extend") {
    if (options.endsAt !== undefined) {
      validateTimestamp(options.endsAt)
      if (durationDays !== undefined || options.endsAt <= now)
        throw new TypeError("Choose a future expiration or a number of days.")
      // Read for a useful validation error; the SQL guard still protects races.
      const existing = await getSubscription(database, userId, now)
      if (
        existing &&
        existing.revision === expectedRevision &&
        options.endsAt <= existing.endsAt
      )
        throw new TypeError(
          "The extension must end after the current expiration."
        )
      mutation = database
        .prepare(
          `UPDATE subscriptions SET end_at = ?, updated_at = ?, revision = revision + 1
           WHERE user_id = ? AND revision = ? AND end_at < ? AND ${manualAccessGuard} RETURNING *`
        )
        .bind(
          options.endsAt,
          now,
          userId,
          expectedRevision,
          options.endsAt,
          userId
        )
      detail = `Extended access until ${new Date(options.endsAt).toISOString()}`
    } else {
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
           AND MAX(end_at, ?) <= ? AND ${manualAccessGuard} RETURNING *`
        )
        .bind(
          now,
          duration,
          now,
          userId,
          expectedRevision,
          now,
          maximumTimestamp - duration,
          userId
        )
      detail = `Extended access by ${durationDays} ${durationDays === 1 ? "day" : "days"}`
    }
  } else {
    if (options.endsAt !== undefined)
      throw new TypeError("Expiration is only supported for extensions.")
    mutation = database
      .prepare(
        `UPDATE subscriptions SET status = ?, updated_at = ?, revision = revision + 1
         WHERE user_id = ? AND revision = ? AND ${manualAccessGuard} RETURNING *`
      )
      .bind(
        action === "revoke" ? "revoked" : "active",
        now,
        userId,
        expectedRevision,
        userId
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
    reason,
    now,
    true
  )
}

export async function updateSubscriptionNotes(
  database: D1Database,
  userId: string,
  notes: string,
  expectedRevision: number,
  actor: string,
  now = Date.now(),
  reason?: string
): Promise<SubscriptionSummary> {
  validateMutation(userId, expectedRevision, actor, now)
  const normalizedNotes = subscriptionNotes(notes)
  const normalizedReason = subscriptionReason(reason)
  const mutation = database
    .prepare(
      `UPDATE subscriptions SET notes = ?, updated_at = ?, revision = revision + 1
       WHERE user_id = ? AND revision = ? RETURNING *`
    )
    .bind(normalizedNotes, now, userId, expectedRevision)
  return mutateWithAudit(
    database,
    mutation,
    userId,
    expectedRevision,
    "update-notes",
    actor,
    `Updated administrator notes: ${normalizedNotes || "(cleared)"}`,
    normalizedReason,
    now
  )
}

/** Reminder preferences affect email only, and remain editable after access ends. */
export async function changeSubscriptionReminders(
  database: D1Database,
  userId: string,
  enabled: boolean,
  expectedRevision: number,
  actor: string,
  now = Date.now(),
  reason?: string
): Promise<SubscriptionSummary> {
  validateMutation(userId, expectedRevision, actor, now)
  if (typeof enabled !== "boolean" || expectedRevision < 1)
    throw new TypeError("Invalid reminder preference.")
  return mutateWithAudit(
    database,
    database
      .prepare(
        `UPDATE subscriptions SET reminder_opt_out_at = ?, updated_at = ?, revision = revision + 1
      WHERE user_id = ? AND revision = ? RETURNING *`
      )
      .bind(enabled ? null : now, now, userId, expectedRevision),
    userId,
    expectedRevision,
    "set-reminders",
    actor,
    enabled
      ? "Enabled trial ending reminders"
      : "Disabled trial ending reminders",
    subscriptionReason(reason),
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
      `SELECT a.id, a.action, a.actor, a.created_at AS createdAt, a.detail, a.reason
       FROM subscription_audit a JOIN subscriptions s ON s.id = a.subscription_id
       WHERE s.user_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 100`
    )
    .bind(userId)
    .all<SubscriptionAudit>()
  return rows.results
}
