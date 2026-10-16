import { randomUUID } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
import { resolveAccountAccess, selectAccountGrant } from "./account-access.ts"
import {
  subscriptionQuery,
  subscriptionSummary,
  type SubscriptionRow,
} from "./subscription-store.ts"
import type { WorkOSEntitlementSummary } from "./subscription-types.ts"
import type { Env } from "./cloudflare.ts"
import {
  getWorkOSEntitlement,
  workosBillingConfiguration,
} from "./workos-entitlements.ts"

interface ManagedRow {
  user_id: string
  organization_id: string
  context: string
  enabled: number
  issued_at: number
  expires_at: number
  revision: number
}
interface ProjectionRow {
  id: string
  revision: number
  fingerprint: string
}

function managedSummary(
  row: ManagedRow | undefined
): WorkOSEntitlementSummary | null {
  return row
    ? {
        userId: row.user_id,
        organizationId: row.organization_id,
        enabled: row.enabled === 1,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        revision: row.revision,
      }
    : null
}

/** Snapshot inputs and CAS the receipt projection; a concurrent grant/token refresh forces a retry. */
export async function getAccountEntitlement(
  source: D1Database | Env,
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
  const started = Date.now()
  const requestedAt = now
  const decisionNow = () => requestedAt + Math.max(0, Date.now() - started)
  const env = "DB" in source ? source : null
  const database = env ? env.DB : (source as D1Database)
  let allowManaged = true
  let managedContext: string | undefined
  let managedOrganization: string | undefined
  if (env) {
    // A missing/revoked session cannot revive old proof. Provider failures must
    // propagate; a historical manual grant never authorizes a replacement receipt.
    const verified = await getWorkOSEntitlement(env, userId, { now })
    allowManaged = verified !== null
    if (verified) {
      managedContext = workosBillingConfiguration(env).context
      managedOrganization = verified.organizationId
    }
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await database.batch([
      database.prepare(`${subscriptionQuery} WHERE s.user_id = ?`).bind(userId),
      database
        .prepare("SELECT * FROM workos_entitlements WHERE user_id = ?")
        .bind(userId),
      database
        .prepare(
          "SELECT id,revision,fingerprint FROM account_entitlements WHERE user_id = ?"
        )
        .bind(userId),
    ])
    const manualRow = snapshot[0].results[0] as unknown as
      SubscriptionRow | undefined
    const managedRow = snapshot[1].results[0] as unknown as
      ManagedRow | undefined
    const prior = snapshot[2].results[0] as unknown as ProjectionRow | undefined
    if (env) now = decisionNow()
    const manual = manualRow ? subscriptionSummary(manualRow, now) : null
    // An overlapping deployment can replace this row after verification. Never
    // consume a proof for another application, feature, or organization.
    const managed =
      allowManaged &&
      (!env ||
        (managedRow !== undefined &&
          managedRow.context === managedContext &&
          managedRow.organization_id === managedOrganization))
        ? managedSummary(managedRow)
        : null
    const billing = null
    const selected = selectAccountGrant(manual, managed, now)
    const access = resolveAccountAccess(manual, now, managed)
    // Accounts without any entitlement have never received a license identity.
    if (!selected.grant && !prior)
      return { manual, managed, billing, access, grant: null }
    const fingerprint = JSON.stringify([
      manualRow?.revision ?? 0,
      managedRow?.revision ?? 0,
      allowManaged,
      selected.source,
      selected.grant?.type ?? null,
      access.status,
      access.startsAt,
      access.endsAt,
    ])
    // Guard both raw inputs, including absence of a managed proof.
    const guard = `COALESCE((SELECT revision FROM subscriptions WHERE user_id = ?),0) = ?
      AND COALESCE((SELECT revision FROM workos_entitlements WHERE user_id = ?),0) = ?`
    const bindings = [
      userId,
      manualRow?.revision ?? 0,
      userId,
      managedRow?.revision ?? 0,
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
      managed,
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
  source: D1Database | Env,
  userIds: string[],
  now = Date.now()
) {
  const results = new Map<
    string,
    Awaited<ReturnType<typeof getAccountEntitlement>>
  >()
  const started = Date.now()
  const uniqueIds = [...new Set(userIds)]
  for (let offset = 0; offset < uniqueIds.length; offset += 10) {
    await Promise.all(
      uniqueIds.slice(offset, offset + 10).map(async (userId) => {
        results.set(
          userId,
          await getAccountEntitlement(
            source,
            userId,
            now + ("DB" in source ? Math.max(0, Date.now() - started) : 0)
          )
        )
      })
    )
  }
  return results
}
