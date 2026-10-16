import { createHash, randomUUID } from "node:crypto"
import type { Env } from "./cloudflare.ts"
import { getSubscription, listSubscriptions } from "./subscription-store.ts"
import { trialReminderEligible } from "./account-access.ts"
import { getWorkOSEntitlement } from "./workos-entitlements.ts"
import { getWorkOSUser } from "./workos-users.ts"

const day = 86_400_000
const reminderWindow = 2 * day
const providerWindow = day
const leaseDuration = 120_000
export const REMINDER_BATCH_SIZE = 10

interface ReminderRow {
  id: string
  subscription_id: string
  user_id: string
  end_at: number
  status:
    | "pending"
    | "sending"
    | "preview"
    | "sent"
    | "failed"
    | "cancelled"
    | "uncertain"
  attempts: number
  updated_at: number
  lease_until: number
  lease_token: string | null
  first_attempt_at: number | null
  recipient: string | null
  sender: string | null
  credential_fingerprint: string | null
  subject: string | null
  message: string | null
  provider_id: string | null
  last_error: string
}

export function reminderMode(env: Env): "resend" | "disabled" {
  return env.RESEND_API_KEY && env.PHOTODEPOT_EMAIL_FROM ? "resend" : "disabled"
}

function accountUrl(env: Env) {
  const callback = new URL(env.WORKOS_REDIRECT_URI ?? "")
  const local =
    callback.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(callback.hostname)
  if (
    (!local && callback.protocol !== "https:") ||
    callback.pathname !== "/api/auth/callback" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash
  )
    throw new Error("Invalid reminder account URL")
  return `${callback.origin}/account`
}

async function reminderSubscription(env: Env, userId: string, now: number) {
  // Refresh paid proof before considering a manual trial notice. Provider outages
  // defer delivery rather than making a paying customer look like an unpaid trial.
  const started = Date.now()
  const managed = await getWorkOSEntitlement(env, userId, { now })
  now += Math.max(0, Date.now() - started)
  if (managed?.enabled && managed.issuedAt <= now && managed.expiresAt > now)
    return null
  return getSubscription(env.DB, userId, now)
}

async function enqueueReminders(env: Env, now: number) {
  await env.DB.prepare(
    `INSERT INTO subscription_reminders (id,subscription_id,user_id,end_at,kind,created_at,updated_at,retry_at)
     SELECT lower(hex(randomblob(16))),s.id,s.user_id,s.end_at,'trial-ending',?,?,? FROM subscriptions s
     WHERE s.type='trial' AND s.status='active' AND s.reminder_opt_out_at IS NULL AND s.started_at<=? AND s.end_at>? AND s.end_at<=?
     AND NOT EXISTS (SELECT 1 FROM subscription_reminders r WHERE r.subscription_id=s.id AND r.end_at=s.end_at AND r.kind='trial-ending')
     ORDER BY s.end_at,s.id LIMIT 100 ON CONFLICT(subscription_id,end_at,kind) DO NOTHING`
  )
    .bind(now, now, now, now, now, now + reminderWindow)
    .run()
}

async function finish(
  env: Env,
  row: ReminderRow,
  status: ReminderRow["status"],
  now: number,
  error = "",
  retryAt = now,
  providerId: string | null = null
) {
  await env.DB.prepare(
    `UPDATE subscription_reminders SET status=?,updated_at=?,retry_at=?,lease_until=0,lease_token=NULL,last_error=?,provider_id=COALESCE(?,provider_id)
     WHERE id=? AND status='sending' AND lease_token=?`
  )
    .bind(status, now, retryAt, error, providerId, row.id, row.lease_token)
    .run()
}

/** Provider deduplication lasts 24h; uncertain sends never retry after that window. */
export async function runSubscriptionReminders(
  env: Env,
  options: { now?: number; fetch?: typeof fetch } = {}
) {
  const mode = reminderMode(env)
  if (mode === "disabled")
    throw new Error("Reminder delivery is not configured")
  const portal = accountUrl(env)
  const now = options.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0)
    throw new TypeError("Invalid reminder time")
  await enqueueReminders(env, now)
  const candidates = await env.DB.prepare(
    `SELECT id FROM subscription_reminders WHERE (status='pending' AND retry_at<=?) OR (status='sending' AND lease_until<=?)
     ORDER BY end_at,id LIMIT ?`
  )
    .bind(now, now, REMINDER_BATCH_SIZE)
    .all<{ id: string }>()
  const result = {
    processed: 0,
    sent: 0,
    deferred: 0,
    failed: 0,
    cancelled: 0,
    uncertain: 0,
    remaining: false,
  }
  for (const candidate of candidates.results) {
    const now = options.now ?? Date.now()
    const row = await env.DB.prepare(
      `UPDATE subscription_reminders SET status='sending',lease_token=?,lease_until=?,updated_at=?
       WHERE id=? AND ((status='pending' AND retry_at<=?) OR (status='sending' AND lease_until<=?)) RETURNING *`
    )
      .bind(randomUUID(), now + leaseDuration, now, candidate.id, now, now)
      .first<ReminderRow>()
    if (!row) continue
    result.processed++
    try {
      const subscription = await reminderSubscription(env, row.user_id, now)
      if (
        !trialReminderEligible(subscription, now) ||
        subscription?.endsAt !== row.end_at
      ) {
        await finish(
          env,
          row,
          "cancelled",
          now,
          "Subscription term changed or access ended"
        )
        result.cancelled++
        continue
      }
      const user = await getWorkOSUser(env, row.user_id)
      if (!user || (row.recipient !== null && user.email !== row.recipient)) {
        await finish(
          env,
          row,
          "cancelled",
          now,
          "Account unavailable or recipient changed"
        )
        result.cancelled++
        continue
      }
      if (!user.emailVerified) {
        await finish(
          env,
          row,
          "pending",
          now,
          "Awaiting verified account email",
          now + 3_600_000
        )
        result.deferred++
        continue
      }
      if (
        row.first_attempt_at !== null &&
        now >= row.first_attempt_at + providerWindow
      ) {
        await finish(
          env,
          row,
          "uncertain",
          now,
          "Delivery outcome needs review; automatic retry window ended"
        )
        result.uncertain++
        continue
      }
      const subject = row.subject ?? "Your Photodepot trial is ending soon"
      const sender = row.sender ?? env.PHOTODEPOT_EMAIL_FROM ?? null
      const message =
        row.message ??
        `Your free Photodepot trial ends on ${new Date(row.end_at).toISOString().replace("T", " ").replace(".000Z", " UTC")}.\n\nYou can view your access and connected computers, or request an extension here:\n${portal}\n\nThis reminder concerns trial access granted by an administrator. Manage any subscription separately in your account billing settings.\n\nPhotodepot`
      const prepared = await env.DB.prepare(
        `UPDATE subscription_reminders SET recipient=?,sender=?,subject=?,message=? WHERE id=? AND status='sending' AND lease_token=? AND lease_until>? RETURNING id`
      )
        .bind(
          user.email,
          sender,
          subject,
          message,
          row.id,
          row.lease_token,
          options.now ?? Date.now()
        )
        .first()
      if (!prepared) {
        result.deferred++
        continue
      }
      // Recheck immediately before transmission so an admin change during lookup
      // cannot knowingly deliver an obsolete term reminder.
      const current = await reminderSubscription(
        env,
        row.user_id,
        options.now ?? Date.now()
      )
      if (
        !trialReminderEligible(current, options.now ?? Date.now()) ||
        current?.endsAt !== row.end_at
      ) {
        await finish(
          env,
          row,
          "cancelled",
          now,
          "Subscription term changed before delivery"
        )
        result.cancelled++
        continue
      }
      const fingerprint = createHash("sha256")
        .update(env.RESEND_API_KEY!)
        .digest("hex")
      if (
        row.first_attempt_at !== null &&
        row.credential_fingerprint !== fingerprint
      ) {
        await finish(
          env,
          row,
          "uncertain",
          now,
          "Delivery credentials changed; review the previous attempt before retrying"
        )
        result.uncertain++
        continue
      }
      const deliveryNow = options.now ?? Date.now()
      const attempt = await env.DB.prepare(
        `UPDATE subscription_reminders SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),credential_fingerprint=COALESCE(credential_fingerprint,?)
         WHERE id=? AND status='sending' AND lease_token=? AND lease_until>?
         AND lease_until>CAST(unixepoch('subsec') * 1000 AS INTEGER)
         AND (first_attempt_at IS NULL OR (first_attempt_at>?
           AND first_attempt_at>CAST(unixepoch('subsec') * 1000 AS INTEGER)-?))
         AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.id=subscription_reminders.subscription_id
           AND s.status='active' AND s.type='trial' AND s.reminder_opt_out_at IS NULL AND s.started_at<=? AND s.end_at=subscription_reminders.end_at AND s.end_at>?
           AND s.end_at>CAST(unixepoch('subsec') * 1000 AS INTEGER)
           AND NOT EXISTS (SELECT 1 FROM workos_entitlements e WHERE e.user_id=s.user_id AND e.enabled=1 AND e.issued_at<=? AND e.expires_at>?))
         RETURNING first_attempt_at,lease_until,end_at`
      )
        .bind(
          deliveryNow,
          fingerprint,
          row.id,
          row.lease_token,
          deliveryNow,
          deliveryNow - providerWindow,
          providerWindow,
          deliveryNow,
          deliveryNow,
          deliveryNow,
          deliveryNow
        )
        .first<
          Pick<ReminderRow, "first_attempt_at" | "lease_until" | "end_at">
        >()
      if (!attempt) {
        result.deferred++
        continue
      }
      // D1 may execute in time but return after the delivery boundary. Recheck
      // the returned lease and term immediately before starting the transport.
      const transmissionNow = options.now ?? Date.now()
      if (transmissionNow >= attempt.end_at) {
        await finish(
          env,
          row,
          "cancelled",
          transmissionNow,
          "Subscription term expired before delivery"
        )
        result.cancelled++
        continue
      }
      if (
        attempt.first_attempt_at !== null &&
        transmissionNow >= attempt.first_attempt_at + providerWindow
      ) {
        await finish(
          env,
          row,
          "uncertain",
          transmissionNow,
          "Delivery outcome needs review; automatic retry window ended"
        )
        result.uncertain++
        continue
      }
      if (transmissionNow >= attempt.lease_until) {
        await finish(
          env,
          row,
          "pending",
          transmissionNow,
          "Delivery lease expired before transmission",
          transmissionNow + 900_000
        )
        result.deferred++
        continue
      }
      const response = await (options.fetch ?? fetch)(
        "https://api.resend.com/emails",
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `photodepot-trial-ending/${row.id}`,
          },
          body: JSON.stringify({
            from: sender,
            to: [user.email],
            subject,
            text: message,
          }),
        }
      )
      let delivery: { id?: unknown } = {}
      try {
        delivery = (await response.json()) as { id?: unknown }
      } catch {
        /* Ambiguous success is retried with exactly the same idempotency key. */
      }
      if (response.ok && typeof delivery.id === "string") {
        await finish(env, row, "sent", now, "", now, delivery.id)
        result.sent++
      } else if (
        response.status === 429 ||
        response.status === 409 ||
        response.status >= 500 ||
        response.ok
      ) {
        await finish(
          env,
          row,
          "pending",
          now,
          "Email provider temporarily unavailable",
          now + 900_000
        )
        result.deferred++
      } else {
        await finish(
          env,
          row,
          "failed",
          now,
          `Email provider rejected delivery (${response.status})`
        )
        result.failed++
      }
    } catch {
      // Never log provider bodies, keys, recipients or user-management responses.
      await finish(
        env,
        row,
        "pending",
        now,
        "Delivery temporarily unavailable",
        now + 900_000
      )
      result.deferred++
    }
  }
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM subscription_reminders WHERE (status='pending' AND retry_at<=?) OR (status='sending' AND lease_until<=?)`
  )
    .bind(now, now)
    .first<{ count: number }>()
  result.remaining = (remaining?.count ?? 0) > 0
  return result
}

export async function subscriptionReminderQueue(env: Env, now = Date.now()) {
  // The Owner tracks expirations even when a customer opts out of email.
  const ids = await env.DB.prepare(
    `SELECT user_id FROM subscriptions WHERE status='active' AND started_at<=? AND end_at>? AND end_at<=? ORDER BY end_at,user_id LIMIT 100`
  )
    .bind(now, now, now + 7 * day)
    .all<{ user_id: string }>()
  const subscriptions = await listSubscriptions(
    env.DB,
    ids.results.map((row) => row.user_id),
    now
  )
  const upcoming = []
  for (let offset = 0; offset < ids.results.length; offset += 10) {
    const entries = await Promise.all(
      ids.results.slice(offset, offset + 10).map(async ({ user_id }) => {
        const user = await getWorkOSUser(env, user_id)
        return {
          subscription: subscriptions.get(user_id)!,
          user: user
            ? {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                emailVerified: user.emailVerified,
                createdAt: Date.parse(user.createdAt),
              }
            : null,
        }
      })
    )
    upcoming.push(...entries)
  }
  const rows = await env.DB.prepare(
    "SELECT * FROM subscription_reminders ORDER BY updated_at DESC,id DESC LIMIT 100"
  ).all<ReminderRow>()
  return {
    mode: reminderMode(env),
    upcoming,
    outbox: rows.results.map((row) => ({
      id: row.id,
      userId: row.user_id,
      endsAt: row.end_at,
      status: row.status,
      attempts: row.attempts,
      updatedAt: row.updated_at,
      subject: row.subject,
      recipient: row.recipient,
      text: row.message,
      error: row.last_error,
    })),
    asOf: now,
    remindWithinDays: 2,
    queueWithinDays: 7,
  }
}
