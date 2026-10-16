import type {
  AccountAccess,
  SubscriptionSummary,
} from "./subscription-types.ts"

/** The only grant-dependent access decision. Device and identity checks are separate. */
export function resolveAccountAccess(
  grant: SubscriptionSummary | null,
  now = Date.now()
): AccountAccess {
  const status = !grant
    ? "none"
    : grant.status === "revoked"
      ? "revoked"
      : now >= grant.endsAt
        ? "expired"
        : "active"
  const canHost = status === "active" && grant !== null && grant.startsAt <= now
  return {
    tier: canHost ? (grant.type === "trial" ? "trial" : "standard") : "free",
    status,
    source: grant ? "manual" : null,
    startsAt: grant?.startsAt ?? null,
    endsAt: grant?.endsAt ?? null,
    canUseLocal: canHost,
    canHost,
  }
}

export function trialReminderEligible(
  grant: SubscriptionSummary | null,
  now: number
) {
  return (
    grant?.remindersEnabled === true &&
    resolveAccountAccess(grant, now).tier === "trial"
  )
}
