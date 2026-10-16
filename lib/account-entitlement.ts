import { randomUUID } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
import { resolveAccountAccess, selectAccountGrant } from "./account-access.ts"
import {
  subscriptionQuery,
  subscriptionSummary,
  type SubscriptionRow,
} from "./subscription-store.ts"
import type { BillingSubscriptionSummary } from "./subscription-types.ts"

interface BillingRow {
  id: string
  user_id: string
  status: string
  starts_at: number
  access_ends_at: number
  price_id: string
  cancel_at_period_end: number
  revision: number
  updated_at: number
}
interface ProjectionRow {
  id: string
  revision: number
  fingerprint: string
}

const billingOrder =
  "CASE WHEN status NOT IN ('canceled','incomplete_expired') THEN 0 ELSE 1 END, starts_at DESC, id DESC"
const billingQuery = `SELECT * FROM stripe_subscriptions WHERE user_id = ? ORDER BY ${billingOrder} LIMIT 1`

function billingSummary(
  row: BillingRow | undefined
): BillingSubscriptionSummary | null {
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.access_ends_at,
        priceId: row.price_id,
        cancelAtPeriodEnd: row.cancel_at_period_end === 1,
        revision: row.revision,
        updatedAt: row.updated_at,
      }
    : null
}

/** Snapshot inputs and CAS the receipt projection; a concurrent grant/webhook forces a retry. */
export async function getAccountEntitlement(
  database: D1Database,
  userId: string,
  now = Date.now()
) {
  if (
    !/^user_[A-Za-z0-9_]+$/.test(userId) ||
    userId.length > 128 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new TypeError("Invalid account access request.")
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await database.batch([
      database.prepare(`${subscriptionQuery} WHERE s.user_id = ?`).bind(userId),
      database.prepare(billingQuery).bind(userId),
      database
        .prepare(
          "SELECT id,revision,fingerprint FROM account_entitlements WHERE user_id = ?"
        )
        .bind(userId),
    ])
    const manualRow = snapshot[0].results[0] as unknown as
      SubscriptionRow | undefined
    const billingRow = snapshot[1].results[0] as unknown as
      BillingRow | undefined
    const prior = snapshot[2].results[0] as unknown as ProjectionRow | undefined
    const manual = manualRow ? subscriptionSummary(manualRow, now) : null
    const billing = billingSummary(billingRow)
    const selected = selectAccountGrant(manual, billing, now)
    const access = resolveAccountAccess(manual, now, billing)
    // Accounts without any entitlement have never received a license identity.
    if (!selected.grant && !prior)
      return { manual, billing, access, grant: null }
    const fingerprint = JSON.stringify([
      manualRow?.revision ?? 0,
      billingRow?.id ?? null,
      billingRow?.revision ?? 0,
      selected.source,
      selected.grant?.type ?? null,
      access.status,
      access.startsAt,
      access.endsAt,
    ])
    // Guard both raw inputs, including absence and a newly preferred subscription.
    const guard = `COALESCE((SELECT revision FROM subscriptions WHERE user_id = ?),0) = ?
      AND COALESCE((SELECT id || ':' || revision FROM stripe_subscriptions WHERE user_id = ? ORDER BY ${billingOrder} LIMIT 1),'') = ?`
    const bindings = [
      userId,
      manualRow?.revision ?? 0,
      userId,
      billingRow ? `${billingRow.id}:${billingRow.revision}` : "",
    ]
    const mutation = prior
      ? database
          .prepare(
            `UPDATE account_entitlements SET fingerprint = ?, revision = CASE WHEN fingerprint = ? THEN revision ELSE MAX(revision + 1, ?) END, updated_at = ?
          WHERE user_id = ? AND revision = ? AND fingerprint = ? AND ${guard} RETURNING id,revision`
          )
          .bind(
            fingerprint,
            fingerprint,
            manualRow?.revision ?? 1,
            now,
            userId,
            prior.revision,
            prior.fingerprint,
            ...bindings
          )
      : database
          .prepare(
            `INSERT INTO account_entitlements (user_id,id,revision,fingerprint,updated_at)
          SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(user_id) DO NOTHING RETURNING id,revision`
          )
          .bind(
            userId,
            manualRow?.id ?? randomUUID(),
            manualRow?.revision ?? 1,
            fingerprint,
            now,
            ...bindings
          )
    const projection = await mutation.first<{ id: string; revision: number }>()
    if (!projection) continue
    return {
      manual,
      billing,
      access,
      grant: selected.grant
        ? {
            ...selected.grant,
            id: projection.id,
            revision: projection.revision,
          }
        : null,
    }
  }
  throw new Error("Account access changed concurrently. Please retry.")
}

export async function listAccountEntitlements(
  database: D1Database,
  userIds: string[],
  now = Date.now()
) {
  const results = new Map<
    string,
    Awaited<ReturnType<typeof getAccountEntitlement>>
  >()
  for (let offset = 0; offset < userIds.length; offset += 10) {
    await Promise.all(
      userIds.slice(offset, offset + 10).map(async (userId) => {
        results.set(userId, await getAccountEntitlement(database, userId, now))
      })
    )
  }
  return results
}
