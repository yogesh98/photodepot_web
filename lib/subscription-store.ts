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
export const INITIAL_TRIAL_DAYS = 7
export const SUBSCRIPTION_DEVICE_LIMIT = 2

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
  binding_revision: number
  current_devices_json?: string
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
    bindingRevision: row.binding_revision,
    devices: JSON.parse(row.current_devices_json ?? "[]"),
    deviceLimit: SUBSCRIPTION_DEVICE_LIMIT,
  }
}

export const subscriptionSelectFields = `s.*, (
  SELECT COALESCE(json_group_array(json_object('id', mac.device_id,
    'bindingRevision', mac.binding_revision, 'assignmentRevision', mac.assignment_revision,
    'activatedAt', mac.activated_at)), '[]')
  FROM (SELECT device_id, binding_revision, assignment_revision, activated_at FROM account_devices
    WHERE user_id = s.user_id AND active = 1 AND binding_revision = s.binding_revision
    ORDER BY activated_at, device_id) mac
  ) AS current_devices_json`

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
    now + INITIAL_TRIAL_DAYS * millisecondsPerDay
  )
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS totalSubscriptions,
       COALESCE(SUM(status = 'active' AND end_at > ?), 0) AS active,
       COALESCE(SUM(status = 'active' AND end_at > ? AND type = 'trial'), 0) AS activeTrials,
       COALESCE(SUM(status = 'active' AND end_at > ? AND type = 'regular'), 0) AS activeStandard,
       COALESCE(SUM(status = 'active' AND end_at <= ?), 0) AS expired,
       COALESCE(SUM(status = 'revoked'), 0) AS revoked,
       COALESCE(SUM(status = 'active' AND end_at > ? AND end_at <= ?), 0) AS expiringSoon,
       (SELECT COUNT(*) FROM account_devices d JOIN subscriptions owner ON owner.user_id = d.user_id
         WHERE d.active = 1 AND d.binding_revision = owner.binding_revision) AS assignedMacs
       FROM subscriptions`
    )
    .bind(now, now, now, now, now, expiringAt)
    .first<Omit<SubscriptionOverview, "asOf" | "expiringWithinDays">>()
  if (!row) throw new Error("Subscription overview is unavailable")
  return { ...row, asOf: now, expiringWithinDays: INITIAL_TRIAL_DAYS }
}

/**
 * Signup owns the trial clock. Repeated callbacks/webhooks cannot restart it,
 * and an existing manual grant, expired term, or revocation always wins.
 */
export async function ensureInitialTrial(
  database: D1Database,
  userId: string,
  startedAt: number,
  now = Date.now()
): Promise<SubscriptionSummary> {
  validateUserId(userId)
  validateTimestamp(startedAt)
  validateTimestamp(now)
  if (
    startedAt > now ||
    startedAt > maximumTimestamp - INITIAL_TRIAL_DAYS * millisecondsPerDay
  )
    throw new TypeError("Invalid signup date.")
  const endsAt = startedAt + INITIAL_TRIAL_DAYS * millisecondsPerDay
  const results = await database.batch<SubscriptionRow>([
    database
      .prepare(
        `INSERT INTO subscriptions (id, user_id, type, status, started_at, end_at, updated_at, revision)
         VALUES (?, ?, 'trial', 'active', ?, ?, ?, 1)
         ON CONFLICT(user_id) DO NOTHING`
      )
      .bind(randomUUID(), userId, startedAt, endsAt, now),
    database
      .prepare(
        `INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail)
         SELECT ?, id, 'initial-trial', 'system:signup', ?, ? FROM subscriptions
         WHERE user_id = ? AND revision = 1 AND changes() = 1`
      )
      .bind(
        randomUUID(),
        now,
        `Automatic ${INITIAL_TRIAL_DAYS}-day signup trial until ${new Date(endsAt).toISOString()}`,
        userId
      ),
    database.prepare(`${subscriptionQuery} WHERE s.user_id = ?`).bind(userId),
  ])
  const row = results[2].results[0]
  if (!row) throw new Error("Initial subscription is unavailable")
  return subscriptionSummary(row, now)
}

async function mutateWithAudit(
  database: D1Database,
  mutation: D1PreparedStatement,
  userId: string,
  expectedRevision: number,
  action: "set" | "revoke" | "restore" | "extend" | "update-notes",
  actor: string,
  detail: string,
  reason: string,
  now: number
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
  if (!results[0].results[0]) throw new SubscriptionConflictError()
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
  const mutation =
    expectedRevision === 0
      ? database
          .prepare(
            `INSERT INTO subscriptions (id, user_id, type, status, started_at, end_at, updated_at, revision, notes)
             VALUES (?, ?, ?, 'active', ?, ?, ?, 1, ?)
             ON CONFLICT(user_id) DO NOTHING RETURNING *`
          )
          .bind(randomUUID(), userId, type, now, endsAt, now, notes ?? "")
      : database
          .prepare(
            `UPDATE subscriptions SET type = ?, status = 'active', started_at = ?,
             end_at = ?, updated_at = ?, revision = revision + 1, notes = COALESCE(?, notes)
             WHERE user_id = ? AND revision = ? RETURNING *`
          )
          .bind(type, now, endsAt, now, notes, userId, expectedRevision)
  return mutateWithAudit(
    database,
    mutation,
    userId,
    expectedRevision,
    "set",
    actor,
    `Set ${type} access until ${new Date(endsAt).toISOString()}${notes !== null ? ` / Notes: ${notes || "(cleared)"}` : ""}`,
    reason,
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
  now = Date.now(),
  options: { reason?: string; endsAt?: number } = {}
): Promise<SubscriptionSummary> {
  validateMutation(userId, expectedRevision, actor, now)
  const reason = subscriptionReason(options.reason)
  if (!["revoke", "restore", "extend"].includes(action))
    throw new TypeError("Invalid subscription action.")
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
           WHERE user_id = ? AND revision = ? AND end_at < ? RETURNING *`
        )
        .bind(options.endsAt, now, userId, expectedRevision, options.endsAt)
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
    }
  } else {
    if (options.endsAt !== undefined)
      throw new TypeError("Expiration is only supported for extensions.")
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
    reason,
    now
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
