export type SubscriptionType = "trial" | "regular"
export type SubscriptionStatus = "active" | "expired" | "revoked"

export interface SubscriptionSummary {
  id: string
  userId: string
  type: SubscriptionType
  status: SubscriptionStatus
  startsAt: number
  endsAt: number
  updatedAt: number
  revision: number
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
}
