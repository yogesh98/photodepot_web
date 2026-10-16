export type SubscriptionType = "trial" | "regular"
export type SubscriptionStatus = "active" | "expired" | "revoked"

/** A provider-neutral access decision. Verified identity is checked by each caller. */
export interface AccountAccess {
  tier: "free" | "trial" | "standard"
  status: "none" | SubscriptionStatus
  source: "manual" | "stripe" | null
  startsAt: number | null
  endsAt: number | null
  canUseLocal: boolean
  canHost: boolean
}

/** Public device information; public keys and proof state stay on the server. */
export interface AccountDevice {
  id: string
  activatedAt: number
  sessionId: string
  revision: number
  deviceName: string | null
  lastUsedAt: number | null
}
export interface AccountDeviceHistory extends AccountDevice {
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
  remindersEnabled: boolean
}

/** Server-confirmed billing state; dates use milliseconds like manual grants. */
export interface BillingSubscriptionSummary {
  id: string
  userId: string
  status: string
  startsAt: number
  endsAt: number
  priceId: string
  cancelAtPeriodEnd: boolean
  revision: number
  updatedAt: number
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
  waitlistTotal: number
  waitlistLast30Days: number
  openRequests: number
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
  billing?: BillingSubscriptionSummary | null
  access: AccountAccess
  devices: AccountDevice[]
}

export interface SubscriptionAudit {
  id: string
  action: string
  actor: string
  createdAt: number
  detail: string
  reason: string
}
