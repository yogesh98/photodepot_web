export type LicenseType = "trial" | "regular"
export interface LicenseSummary {
  id: string
  keySuffix: string
  type: LicenseType
  status: "active" | "revoked"
  customerName: string
  email: string
  notes: string
  deviceId: string | null
  createdAt: number
  updatedAt: number
  lastVerifiedAt: number | null
  revision: number
}
export interface LicenseAudit {
  id: string
  action: string
  actor: string
  createdAt: number
  detail: string
}
