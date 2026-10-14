import { randomUUID } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
import type { LicenseSummary, LicenseType } from "./license-types.ts"
import { generateLicenseKey, hashLicenseKey } from "./license-crypto.ts"

export interface LicenseRow {
  id: string
  key_hash: string
  key_suffix: string
  type: LicenseType
  status: "active" | "revoked"
  customer_name: string
  email: string
  notes: string
  current_device_id: string | null
  binding_revision: number
  revision: number
  created_at: number
  updated_at: number
  last_verified_at: number | null
}
export function licenseSummary(row: LicenseRow): LicenseSummary {
  return {
    id: row.id,
    keySuffix: row.key_suffix,
    type: row.type,
    status: row.status,
    customerName: row.customer_name,
    email: row.email,
    notes: row.notes,
    deviceId: row.current_device_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    revision: row.revision,
  }
}
export async function grantLicense(
  database: D1Database,
  values: {
    type: LicenseType
    customerName: string
    email: string
    notes: string
  },
  actor: string,
  now = Date.now()
) {
  const id = randomUUID()
  const key = generateLicenseKey()
  const statements = [
    database
      .prepare(
        `INSERT INTO licenses (id, key_hash, key_suffix, type, customer_name, email, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        hashLicenseKey(key),
        key.slice(-4),
        values.type,
        values.customerName,
        values.email,
        values.notes,
        now,
        now
      ),
    database
      .prepare(
        "INSERT INTO license_audit (id, license_id, action, actor, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        randomUUID(),
        id,
        "grant",
        actor,
        now,
        `Granted ${values.type} license`
      ),
  ]
  await database.batch(statements)
  return {
    key,
    license: licenseSummary(
      (await database
        .prepare("SELECT * FROM licenses WHERE id = ?")
        .bind(id)
        .first<LicenseRow>())!
    ),
  }
}
export async function changeLicense(
  database: D1Database,
  id: string,
  action: "revoke" | "restore" | "set-type" | "reset-device",
  type: LicenseType | undefined,
  actor: string,
  now = Date.now()
) {
  const assignments =
    action === "reset-device"
      ? "current_device_id = NULL, binding_revision = binding_revision + 1"
      : action === "set-type"
        ? "type = ?"
        : "status = ?"
  const value =
    action === "set-type" ? type : action === "revoke" ? "revoked" : "active"
  const values = action === "reset-device" ? [now, id] : [value!, now, id]
  const detail =
    action === "set-type"
      ? `Changed type to ${type}`
      : action === "reset-device"
        ? "Reset Mac assignment; previous device must activate again"
        : action === "revoke"
          ? "Revoked license"
          : "Restored license"
  const results = await database.batch<LicenseRow>([
    database
      .prepare(
        `UPDATE licenses SET ${assignments}, revision = revision + 1, updated_at = ? WHERE id = ? RETURNING *`
      )
      .bind(...values),
    database
      .prepare(
        `INSERT INTO license_audit (id, license_id, action, actor, created_at, detail) SELECT ?, id, ?, ?, ?, ? FROM licenses WHERE id = ?`
      )
      .bind(randomUUID(), action, actor, now, detail, id),
  ])
  return results[0].results[0] ? licenseSummary(results[0].results[0]) : null
}
export async function activateDevice(
  database: D1Database,
  keyHash: string,
  deviceId: string,
  publicKey: string,
  now = Date.now()
) {
  // Replacing a revoked key releases only that revoked assignment. Capacity
  // checks and both binding changes occur within this single D1 transaction.
  const revokedAssignment = `status = 'revoked' AND current_device_id = ?
    AND EXISTS (SELECT 1 FROM license_devices d WHERE d.device_id = ? AND d.license_id = licenses.id AND d.binding_revision = licenses.binding_revision)
    AND EXISTS (SELECT 1 FROM licenses target WHERE target.key_hash = ? AND target.id != licenses.id AND target.status = 'active' AND (target.current_device_id IS NULL OR target.current_device_id = ?))`
  const previousParameters = [deviceId, deviceId, keyHash, deviceId]
  const results = await database.batch<LicenseRow>([
    database
      .prepare(
        `INSERT INTO license_audit (id, license_id, action, actor, created_at, detail) SELECT ?, id, 'replace-revoked-device', 'device', ?, 'Mac activated a replacement license; previous revoked assignment released' FROM licenses WHERE ${revokedAssignment}`
      )
      .bind(randomUUID(), now, ...previousParameters),
    database
      .prepare(
        `UPDATE licenses SET current_device_id = NULL, binding_revision = binding_revision + 1, revision = revision + 1, updated_at = ? WHERE ${revokedAssignment}`
      )
      .bind(now, ...previousParameters),
    database
      .prepare(
        `UPDATE licenses SET current_device_id = ?, revision = revision + CASE WHEN current_device_id IS NULL THEN 1 ELSE 0 END, updated_at = ?, last_verified_at = ?
      WHERE key_hash = ? AND status = 'active' AND (current_device_id IS NULL OR current_device_id = ?)
      AND NOT EXISTS (SELECT 1 FROM license_devices d JOIN licenses other ON other.id = d.license_id WHERE d.device_id = ? AND other.id != licenses.id AND other.current_device_id = d.device_id AND other.binding_revision = d.binding_revision)
      RETURNING *`
      )
      .bind(deviceId, now, now, keyHash, deviceId, deviceId),
    database
      .prepare(
        `INSERT INTO license_devices (device_id, license_id, public_key, binding_revision, activated_at)
      SELECT ?, id, ?, binding_revision, ? FROM licenses WHERE key_hash = ? AND current_device_id = ? AND status = 'active'
      ON CONFLICT(device_id) DO UPDATE SET license_id = excluded.license_id, public_key = excluded.public_key, binding_revision = excluded.binding_revision, activated_at = excluded.activated_at
      WHERE license_devices.license_id = excluded.license_id OR NOT EXISTS (SELECT 1 FROM licenses previous WHERE previous.id = license_devices.license_id AND previous.current_device_id = license_devices.device_id AND previous.binding_revision = license_devices.binding_revision)`
      )
      .bind(deviceId, publicKey, now, keyHash, deviceId),
    database
      .prepare(
        `INSERT INTO license_audit (id, license_id, action, actor, created_at, detail) SELECT ?, id, 'activate', 'device', ?, 'Mac activated / assignment ' || binding_revision FROM licenses WHERE key_hash = ? AND current_device_id = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM license_audit a WHERE a.license_id = licenses.id AND a.action = 'activate' AND a.detail = 'Mac activated / assignment ' || licenses.binding_revision)`
      )
      .bind(randomUUID(), now, keyHash, deviceId),
  ])
  return results[2].results[0] ?? null
}
export interface DeviceLicense extends LicenseRow {
  public_key: string
  device_binding_revision: number
}
export function findDevice(database: D1Database, deviceId: string) {
  return database
    .prepare(
      "SELECT l.*, d.public_key, d.binding_revision AS device_binding_revision FROM license_devices d JOIN licenses l ON l.id = d.license_id WHERE d.device_id = ?"
    )
    .bind(deviceId)
    .first<DeviceLicense>()
}
