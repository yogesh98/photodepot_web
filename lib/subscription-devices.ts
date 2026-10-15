import { randomUUID } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
import { CHALLENGE_PATTERN, parseDevicePublicKey } from "./license-crypto.ts"
import {
  SubscriptionConflictError,
  SUBSCRIPTION_DEVICE_LIMIT,
  subscriptionReason,
  subscriptionSummary,
  subscriptionSelectFields,
  subscriptionQuery,
  type SubscriptionRow,
} from "./subscription-store.ts"
import type {
  SubscriptionSummary,
  SubscriptionDeviceHistory,
} from "./subscription-types.ts"

/** Server-only ownership and public signing key, including reset device history. */
export interface SubscriptionDevice {
  deviceId: string
  userId: string
  publicKey: string
  bindingRevision: number
  assignmentRevision: number
  active: boolean
  currentBindingRevision: number
  subscription: SubscriptionSummary
}

interface SubscriptionDeviceRow extends SubscriptionRow {
  device_id: string
  public_key: string
  device_binding_revision: number
  assignment_revision: number
  device_active: number
}
function deviceSummary(
  row: SubscriptionDeviceRow,
  now: number
): SubscriptionDevice {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    publicKey: row.public_key,
    bindingRevision: row.device_binding_revision,
    assignmentRevision: row.assignment_revision,
    active:
      row.device_active === 1 &&
      row.device_binding_revision === row.binding_revision,
    currentBindingRevision: row.binding_revision,
    subscription: subscriptionSummary(row, now),
  }
}
function validateUserId(userId: string) {
  if (
    typeof userId !== "string" ||
    !/^user_[A-Za-z0-9_]+$/.test(userId) ||
    userId.length > 128
  )
    throw new TypeError("Invalid WorkOS user.")
}
function validateDeviceId(deviceId: string) {
  if (typeof deviceId !== "string" || !/^[a-f0-9]{64}$/.test(deviceId))
    throw new TypeError("Invalid device.")
}
function validateNow(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new TypeError("Invalid subscription date.")
}
const deviceQuery = `SELECT ${subscriptionSelectFields}, d.device_id, d.public_key,
  d.binding_revision AS device_binding_revision, d.assignment_revision, d.active AS device_active
  FROM account_devices d JOIN subscriptions s ON s.user_id = d.user_id
  WHERE d.device_id = ?`

export async function getSubscriptionDevice(
  database: D1Database,
  deviceId: string,
  now = Date.now()
): Promise<SubscriptionDevice | null> {
  validateDeviceId(deviceId)
  validateNow(now)
  const row = await database
    .prepare(deviceQuery)
    .bind(deviceId)
    .first<SubscriptionDeviceRow>()
  return row ? deviceSummary(row, now) : null
}

export async function bindSubscriptionDevice(
  database: D1Database,
  values: {
    userId: string
    deviceId: string
    publicKey: string
    expectedBindingRevision?: number
    pairing?: { tokenHash: string; challenge: string }
  },
  now = Date.now()
): Promise<SubscriptionDevice | null> {
  const { userId, deviceId, publicKey, expectedBindingRevision, pairing } =
    values
  validateUserId(userId)
  validateNow(now)
  if (parseDevicePublicKey(publicKey).deviceId !== deviceId)
    throw new TypeError("Invalid device.")
  if (
    expectedBindingRevision !== undefined &&
    (!Number.isSafeInteger(expectedBindingRevision) ||
      expectedBindingRevision < 1)
  )
    throw new TypeError("Invalid Mac assignment revision.")
  if (
    pairing &&
    (!/^[a-f0-9]{64}$/.test(pairing.tokenHash) ||
      !CHALLENGE_PATTERN.test(pairing.challenge) ||
      expectedBindingRevision === undefined)
  )
    throw new TypeError("Invalid Mac sign-in request.")

  // All slot checks and the following write share one D1 transaction. A reset
  // invalidates both the approval's account epoch and its individual Mac epoch.
  const pairingCondition = pairing
    ? `AND EXISTS (SELECT 1 FROM account_pairings p WHERE p.token_hash = ? AND p.status = 'approved'
         AND p.expires_at > MAX(?, CAST(unixepoch('subsec') * 1000 AS INTEGER))
         AND p.user_id = subscriptions.user_id AND p.device_id = ? AND p.public_key = ? AND p.challenge = ?
         AND p.approved_binding_revision = subscriptions.binding_revision
         AND p.approved_device_revision = COALESCE((SELECT assignment_revision FROM account_devices WHERE device_id = ?), 1))
       AND subscriptions.end_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`
    : `AND NOT EXISTS (SELECT 1 FROM account_devices d WHERE d.device_id = ?
         AND (d.active != 1 OR d.binding_revision != subscriptions.binding_revision))`
  const results = await database.batch<SubscriptionDeviceRow>([
    database
      .prepare(
        `UPDATE subscriptions SET
       revision = revision + CASE WHEN EXISTS (SELECT 1 FROM account_devices d WHERE d.device_id = ?
         AND d.user_id = subscriptions.user_id AND d.active = 1 AND d.binding_revision = subscriptions.binding_revision) THEN 0 ELSE 1 END,
       updated_at = CASE WHEN EXISTS (SELECT 1 FROM account_devices d WHERE d.device_id = ?
         AND d.user_id = subscriptions.user_id AND d.active = 1 AND d.binding_revision = subscriptions.binding_revision) THEN updated_at ELSE ? END
       WHERE user_id = ? AND status = 'active' AND started_at <= ? AND end_at > ?
       AND (? IS NULL OR binding_revision = ?)
       AND NOT EXISTS (SELECT 1 FROM account_devices d WHERE d.device_id = ? AND (d.user_id != ? OR d.public_key != ?))
       AND NOT EXISTS (SELECT 1 FROM desktop_sessions current WHERE current.device_id = ? AND current.user_id != subscriptions.user_id AND current.active = 1)
       AND (EXISTS (SELECT 1 FROM account_devices d WHERE d.device_id = ? AND d.user_id = subscriptions.user_id
         AND d.active = 1 AND d.binding_revision = subscriptions.binding_revision)
         OR (SELECT COUNT(*) FROM (SELECT d.device_id FROM account_devices d WHERE d.user_id = subscriptions.user_id
           AND d.active = 1 AND d.binding_revision = subscriptions.binding_revision
           AND NOT EXISTS (SELECT 1 FROM desktop_sessions current WHERE current.device_id = d.device_id AND current.active = 1)
           UNION SELECT ds.device_id FROM desktop_sessions ds WHERE ds.user_id = subscriptions.user_id AND ds.active = 1) used
           WHERE used.device_id != ?) < ${SUBSCRIPTION_DEVICE_LIMIT})
       ${pairingCondition} RETURNING *`
      )
      .bind(
        deviceId,
        deviceId,
        now,
        userId,
        now,
        now,
        expectedBindingRevision ?? null,
        expectedBindingRevision ?? null,
        deviceId,
        userId,
        publicKey,
        deviceId,
        deviceId,
        deviceId,
        ...(pairing
          ? [
              pairing.tokenHash,
              now,
              deviceId,
              publicKey,
              pairing.challenge,
              deviceId,
            ]
          : [deviceId])
      ),
    database
      .prepare(
        `INSERT INTO account_devices (device_id, user_id, public_key, binding_revision, activated_at, active, assignment_revision)
       SELECT ?, user_id, ?, binding_revision, ?, 1, 1 FROM subscriptions WHERE user_id = ? AND changes() = 1
       ON CONFLICT(device_id) DO UPDATE SET binding_revision = excluded.binding_revision, active = 1,
         activated_at = CASE WHEN account_devices.active != 1 OR account_devices.binding_revision != excluded.binding_revision
           THEN excluded.activated_at ELSE account_devices.activated_at END
       WHERE account_devices.user_id = excluded.user_id AND account_devices.public_key = excluded.public_key
       AND (account_devices.active != 1 OR account_devices.binding_revision != excluded.binding_revision)`
      )
      .bind(deviceId, publicKey, now, userId),
    database
      .prepare(
        `INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail)
       SELECT ?, s.id, 'bind-device', s.user_id, ?, 'Mac connected / account assignment ' || s.binding_revision ||
         ' / Mac assignment ' || d.assignment_revision || ' / ' || d.device_id
       FROM subscriptions s JOIN account_devices d ON d.user_id = s.user_id
       WHERE s.user_id = ? AND d.device_id = ? AND changes() = 1
       AND NOT EXISTS (SELECT 1 FROM subscription_audit a WHERE a.subscription_id = s.id AND a.action = 'bind-device'
         AND a.detail = 'Mac connected / account assignment ' || s.binding_revision ||
           ' / Mac assignment ' || d.assignment_revision || ' / ' || d.device_id)`
      )
      .bind(randomUUID(), now, userId, deviceId),
    database.prepare(deviceQuery).bind(deviceId),
  ])
  if (!results[0].results[0] || !results[3].results[0]) return null
  return deviceSummary(results[3].results[0], now)
}

/** Omit deviceId to reset both slots; supplying it leaves the other Mac active. */
export async function resetSubscriptionDevice(
  database: D1Database,
  userId: string,
  expectedRevision: number,
  actor: string,
  now = Date.now(),
  reason?: string,
  deviceId?: string
): Promise<SubscriptionSummary> {
  validateUserId(userId)
  validateNow(now)
  if (deviceId !== undefined) validateDeviceId(deviceId)
  const normalizedReason = subscriptionReason(reason)
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER ||
    typeof actor !== "string" ||
    !actor.trim() ||
    actor.length > 320
  )
    throw new TypeError("Invalid subscription reset.")
  const auditId = randomUUID()
  const results = await database.batch<SubscriptionRow>([
    database
      .prepare(
        `UPDATE subscriptions SET binding_revision = binding_revision + ?, revision = revision + 1, updated_at = ?
       WHERE user_id = ? AND revision = ?
       ${
         deviceId === undefined
           ? ""
           : `AND (EXISTS (SELECT 1 FROM account_devices d WHERE d.user_id = subscriptions.user_id
         AND d.device_id = ? AND d.active = 1 AND d.binding_revision = subscriptions.binding_revision)
         OR EXISTS (SELECT 1 FROM desktop_sessions ds WHERE ds.user_id = subscriptions.user_id AND ds.device_id = ? AND ds.active = 1))`
       } RETURNING *`
      )
      .bind(
        deviceId === undefined ? 1 : 0,
        now,
        userId,
        expectedRevision,
        ...(deviceId === undefined ? [] : [deviceId, deviceId])
      ),
    database
      .prepare(
        `INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail, reason)
       SELECT ?, id, 'reset-device', ?, ?, ?, ? FROM subscriptions
       WHERE user_id = ? AND revision = ? AND changes() = 1`
      )
      .bind(
        auditId,
        actor,
        now,
        deviceId === undefined
          ? "Reset all Mac assignments; previous Macs must sign in again"
          : `Reset Mac assignment / ${deviceId}; this Mac must sign in again`,
        normalizedReason,
        userId,
        expectedRevision + 1
      ),
    // The fresh audit ID proves this batch won its revision, including reset-all
    // when no Mac is connected. Retaining keys ensures live signed revocation.
    database
      .prepare(
        `UPDATE account_devices SET active = 0, assignment_revision = assignment_revision + ?
       WHERE user_id = ? ${deviceId === undefined ? "" : "AND device_id = ?"}
       AND EXISTS (SELECT 1 FROM subscription_audit WHERE id = ?)`
      )
      .bind(
        deviceId === undefined ? 0 : 1,
        userId,
        ...(deviceId === undefined ? [] : [deviceId]),
        auditId
      ),
    database
      .prepare(
        `UPDATE desktop_sessions SET active = 0, revision = revision + 1, updated_at = ?
      WHERE user_id = ? AND active = 1 ${deviceId === undefined ? "" : "AND device_id = ?"}
      AND EXISTS (SELECT 1 FROM subscription_audit WHERE id = ?)`
      )
      .bind(
        now,
        userId,
        ...(deviceId === undefined ? [] : [deviceId]),
        auditId
      ),
    database
      .prepare(
        `UPDATE account_pairings SET status = 'cancelled' WHERE user_id = ? AND account_version = 1
      ${deviceId === undefined ? "" : "AND device_id = ?"} AND EXISTS (SELECT 1 FROM subscription_audit WHERE id = ?)`
      )
      .bind(userId, ...(deviceId === undefined ? [] : [deviceId]), auditId),
    database.prepare(`${subscriptionQuery} WHERE s.user_id = ?`).bind(userId),
  ])
  if (!results[0].results[0]) throw new SubscriptionConflictError()
  const row = results[5].results[0]
  if (!row) throw new Error("Updated subscription is unavailable")
  return subscriptionSummary(row, now)
}

export async function listSubscriptionDevices(
  database: D1Database,
  userId: string
): Promise<SubscriptionDeviceHistory[]> {
  validateUserId(userId)
  const rows = await database
    .prepare(
      `SELECT d.device_id AS id, d.binding_revision AS bindingRevision, d.assignment_revision AS assignmentRevision,
     d.activated_at AS activatedAt, (d.active = 1 AND d.binding_revision = s.binding_revision) AS current
     FROM account_devices d JOIN subscriptions s ON s.user_id = d.user_id
     WHERE d.user_id = ? ORDER BY d.activated_at DESC, d.device_id`
    )
    .bind(userId)
    .all<Omit<SubscriptionDeviceHistory, "current"> & { current: number }>()
  return rows.results.map((row) => ({ ...row, current: row.current === 1 }))
}
