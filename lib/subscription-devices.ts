import { randomUUID } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
import { CHALLENGE_PATTERN, parseDevicePublicKey } from "./license-crypto.ts"
import {
  SubscriptionConflictError,
  subscriptionReason,
  subscriptionSummary,
  type SubscriptionRow,
} from "./subscription-store.ts"
import type {
  SubscriptionSummary,
  SubscriptionDeviceHistory,
} from "./subscription-types.ts"

export interface SubscriptionDevice {
  deviceId: string
  userId: string
  publicKey: string
  bindingRevision: number
  currentDeviceId: string | null
  currentBindingRevision: number
  subscription: SubscriptionSummary
}

interface SubscriptionDeviceRow extends SubscriptionRow {
  device_id: string
  public_key: string
  device_binding_revision: number
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
    currentDeviceId: row.current_device_id,
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

function validateNow(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new TypeError("Invalid subscription date.")
}

const deviceQuery = `SELECT s.*, d.device_id, d.public_key,
  d.binding_revision AS device_binding_revision,
  current.activated_at AS current_device_activated_at
  FROM account_devices d JOIN subscriptions s ON s.user_id = d.user_id
  LEFT JOIN account_devices current ON current.device_id = s.current_device_id
    AND current.user_id = s.user_id AND current.binding_revision = s.binding_revision
  WHERE d.device_id = ?`

export async function getSubscriptionDevice(
  database: D1Database,
  deviceId: string,
  now = Date.now()
): Promise<SubscriptionDevice | null> {
  if (typeof deviceId !== "string" || !/^[a-f0-9]{64}$/.test(deviceId))
    throw new TypeError("Invalid device.")
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
  // Approval must still authorize this exact Mac when the binding commits.
  // The database clock also closes expiry races while the batch is queued.
  const pairingCondition = pairing
    ? `AND EXISTS (SELECT 1 FROM account_pairings p
         WHERE p.token_hash = ? AND p.status = 'approved'
         AND p.expires_at > MAX(?, CAST(unixepoch('subsec') * 1000 AS INTEGER))
         AND p.user_id = subscriptions.user_id AND p.device_id = ?
         AND p.public_key = ? AND p.challenge = ?
         AND p.approved_binding_revision = subscriptions.binding_revision)
       AND subscriptions.end_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`
    : ""
  const results = await database.batch<SubscriptionDeviceRow>([
    database
      .prepare(
        `UPDATE subscriptions SET current_device_id = ?,
         revision = revision + CASE WHEN current_device_id IS NULL THEN 1 ELSE 0 END,
         updated_at = CASE WHEN current_device_id IS NULL THEN ? ELSE updated_at END
         WHERE user_id = ? AND status = 'active' AND started_at <= ? AND end_at > ?
         AND (current_device_id IS NULL OR current_device_id = ?)
         AND (? IS NULL OR binding_revision = ?)
         AND NOT EXISTS (SELECT 1 FROM account_devices d WHERE d.device_id = ? AND d.user_id != ?)
         ${pairingCondition}
         RETURNING *`
      )
      .bind(
        deviceId,
        now,
        userId,
        now,
        now,
        deviceId,
        expectedBindingRevision ?? null,
        expectedBindingRevision ?? null,
        deviceId,
        userId,
        ...(pairing
          ? [pairing.tokenHash, now, deviceId, publicKey, pairing.challenge]
          : [])
      ),
    database
      .prepare(
        `INSERT INTO account_devices (device_id, user_id, public_key, binding_revision, activated_at)
         SELECT ?, user_id, ?, binding_revision, ? FROM subscriptions
         WHERE user_id = ? AND current_device_id = ? AND status = 'active'
         AND started_at <= ? AND end_at > ? AND changes() = 1
         ON CONFLICT(device_id) DO UPDATE SET binding_revision = excluded.binding_revision,
           activated_at = CASE WHEN account_devices.binding_revision != excluded.binding_revision
             THEN excluded.activated_at ELSE account_devices.activated_at END
         WHERE account_devices.user_id = excluded.user_id AND account_devices.public_key = excluded.public_key`
      )
      .bind(deviceId, publicKey, now, userId, deviceId, now, now),
    database
      .prepare(
        `INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail)
         SELECT ?, id, 'bind-device', user_id, ?, 'Mac connected / assignment ' || binding_revision || ' / ' || current_device_id
         FROM subscriptions WHERE user_id = ? AND current_device_id = ? AND changes() = 1
         AND NOT EXISTS (SELECT 1 FROM subscription_audit a WHERE a.subscription_id = subscriptions.id
           AND a.action = 'bind-device' AND a.detail = 'Mac connected / assignment ' || binding_revision || ' / ' || current_device_id)`
      )
      .bind(randomUUID(), now, userId, deviceId),
    database.prepare(deviceQuery).bind(deviceId),
  ])
  if (!results[0].results[0] || !results[3].results[0]) return null
  return deviceSummary(results[3].results[0], now)
}

export async function resetSubscriptionDevice(
  database: D1Database,
  userId: string,
  expectedRevision: number,
  actor: string,
  now = Date.now(),
  reason?: string
): Promise<SubscriptionSummary> {
  validateUserId(userId)
  validateNow(now)
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
  const results = await database.batch<SubscriptionDeviceRow>([
    database
      .prepare(
        `UPDATE subscriptions SET current_device_id = NULL, binding_revision = binding_revision + 1,
         revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING *`
      )
      .bind(now, userId, expectedRevision),
    database
      .prepare(
        `INSERT INTO subscription_audit (id, subscription_id, action, actor, created_at, detail, reason)
         SELECT ?, id, 'reset-device', ?, ?, 'Reset Mac assignment; previous Mac must sign in again', ?
         FROM subscriptions WHERE user_id = ? AND revision = ? AND changes() = 1`
      )
      .bind(
        randomUUID(),
        actor,
        now,
        normalizedReason,
        userId,
        expectedRevision + 1
      ),
  ])
  const row = results[0].results[0]
  if (!row) throw new SubscriptionConflictError()
  return subscriptionSummary(row, now)
}

/** Includes historical assignment identifiers, never the device signing key. */
export async function listSubscriptionDevices(
  database: D1Database,
  userId: string
): Promise<SubscriptionDeviceHistory[]> {
  validateUserId(userId)
  const rows = await database
    .prepare(
      `SELECT d.device_id AS id, d.binding_revision AS bindingRevision,
       d.activated_at AS activatedAt,
       (d.device_id = s.current_device_id AND d.binding_revision = s.binding_revision) AS current
       FROM account_devices d JOIN subscriptions s ON s.user_id = d.user_id
       WHERE d.user_id = ? ORDER BY d.activated_at DESC, d.device_id`
    )
    .bind(userId)
    .all<
      Omit<SubscriptionDeviceHistory, "current"> & { current: number | null }
    >()
  return rows.results.map((row) => ({ ...row, current: row.current === 1 }))
}
