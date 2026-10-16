import type { D1Database } from "@cloudflare/workers-types"

export class BillingConflictError extends Error {}
export class BillingUnavailableError extends Error {}

export interface BillingCustomer {
  user_id: string
  stripe_customer_id: string | null
  workos_organization_id: string | null
  trial_used: number
  customer_create_token: string
  customer_create_started_at: number | null
  customer_create_email: string | null
  checkout_session_id: string | null
  checkout_expires_at: number | null
  checkout_price_id: string | null
  checkout_started_at: number | null
  checkout_trial_days: number | null
  checkout_request_json: string | null
  checkout_generation: number
  operation_token: string | null
  operation_lease_until: number
}

export async function getBillingCustomer(db: D1Database, userId: string) {
  return db
    .prepare("SELECT * FROM stripe_customers WHERE user_id = ?")
    .bind(userId)
    .first<BillingCustomer>()
}

/** Serialize customer creation, Checkout and Portal operations for an account. */
export async function lockBillingAccount(
  db: D1Database,
  userId: string,
  create = false,
  now = Date.now()
) {
  if (create)
    await db
      .prepare(
        `INSERT OR IGNORE INTO stripe_customers (user_id, customer_create_token) VALUES (?, ?)`
      )
      .bind(userId, crypto.randomUUID())
      .run()
  const token = crypto.randomUUID()
  const result = await db
    .prepare(
      `UPDATE stripe_customers SET operation_token = ?, operation_lease_until = ?
    WHERE user_id = ? AND operation_lease_until <= ?`
    )
    .bind(token, now + 120_000, userId, now)
    .run()
  if (result.meta.changes !== 1)
    throw new BillingConflictError(
      "Billing is being updated. Please try again."
    )
  const customer = await getBillingCustomer(db, userId)
  if (!customer || customer.operation_token !== token)
    throw new BillingUnavailableError("Billing lease unavailable")
  return { customer, token }
}

export async function unlockBillingAccount(
  db: D1Database,
  userId: string,
  token: string
) {
  await db
    .prepare(
      `UPDATE stripe_customers SET operation_token = NULL, operation_lease_until = 0
    WHERE user_id = ? AND operation_token = ?`
    )
    .bind(userId, token)
    .run()
}

export async function updateBillingCustomer(
  db: D1Database,
  userId: string,
  token: string,
  changes: Partial<BillingCustomer>
) {
  // Column identifiers come only from this server-owned allowlist.
  const allowed = [
    "stripe_customer_id",
    "workos_organization_id",
    "trial_used",
    "customer_create_started_at",
    "customer_create_email",
    "checkout_session_id",
    "checkout_expires_at",
    "checkout_price_id",
    "checkout_started_at",
    "checkout_trial_days",
    "checkout_request_json",
    "checkout_generation",
  ] as const
  const keys = allowed.filter((key) => changes[key] !== undefined)
  if (!keys.length) return
  const result = await db
    .prepare(
      `UPDATE stripe_customers SET ${keys.map((key) => `${key} = ?`).join(", ")}
    WHERE user_id = ? AND operation_token = ? AND operation_lease_until > ?`
    )
    .bind(
      ...keys.map((key) => changes[key] as string | number | null),
      userId,
      token,
      Date.now()
    )
    .run()
  if (result.meta.changes !== 1)
    throw new BillingUnavailableError("Billing lease expired")
}

export async function hasUsedManualTrial(db: D1Database, userId: string) {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM subscriptions s WHERE s.user_id = ? AND
    (s.type = 'trial' OR EXISTS (SELECT 1 FROM subscription_audit a WHERE a.subscription_id = s.id
      AND (a.action = 'initial-trial' OR (a.action = 'set' AND a.detail LIKE '%trial%')))) LIMIT 1`
    )
    .bind(userId)
    .first()
  return row !== null
}
