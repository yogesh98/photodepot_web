import type { LicenseSummary, LicenseType } from "./license-types.ts"

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
