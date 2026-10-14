export type SubscriptionType = "trial" | "regular"
export type SubscriptionStatus = "active" | "expired" | "revoked"

/** Dashboard-safe Mac assignment data. Device public keys stay on the server. */
export interface SubscriptionDevice {
  id: string
  bindingRevision: number
  activatedAt: number
}

export interface SubscriptionDeviceHistory extends SubscriptionDevice {
  current: boolean
}

export interface SubscriptionSummary {
  id: string
  userId: string
  type: SubscriptionType
  status: SubscriptionStatus
  startsAt: number
  endsAt: number
  updatedAt: number
  revision: number
  notes: string
  bindingRevision: number
  device: SubscriptionDevice | null
}

export interface SubscriptionOverview {
  totalSubscriptions: number
  active: number
  activeTrials: number
  activeStandard: number
  expired: number
  revoked: number
  expiringSoon: number
  assignedMacs: number
  asOf: number
  expiringWithinDays: number
}

export interface WorkOSUserSummary {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  emailVerified: boolean
  createdAt: number
  subscription: SubscriptionSummary | null
}

export interface SubscriptionAudit {
  id: string
  action: string
  actor: string
  createdAt: number
  detail: string
  reason: string
}
