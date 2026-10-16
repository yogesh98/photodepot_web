import type {
  AccountAccess,
  BillingSubscriptionSummary,
  SubscriptionSummary,
} from "./subscription-types.ts"

/** The only grant-dependent access decision. Device and identity checks are separate. */
export function resolveAccountAccess(
  grant: SubscriptionSummary | null,
  now = Date.now(),
  billing: BillingSubscriptionSummary | null = null
): AccountAccess {
  const selected = selectAccountGrant(grant, billing, now)
  grant = selected.grant
  const status = !grant
    ? "none"
    : grant.status === "revoked"
      ? "revoked"
      : now >= grant.endsAt
        ? "expired"
        : "active"
  const canHost = status === "active" && grant !== null && grant.startsAt <= now
  return {
    tier: canHost ? (grant?.type === "trial" ? "trial" : "standard") : "free",
    status,
    source: selected.source,
    startsAt: grant?.startsAt ?? null,
    endsAt: grant?.endsAt ?? null,
    canUseLocal: canHost,
    canHost,
  }
}

/** Preserve a valid manual grant; choose the later deadline, with Stripe winning ties. */
export function selectAccountGrant(
  manual: SubscriptionSummary | null,
  billing: BillingSubscriptionSummary | null,
  now = Date.now()
): { grant: SubscriptionSummary | null; source: AccountAccess["source"] } {
  const paid: SubscriptionSummary | null = billing
    ? {
        id: billing.id,
        userId: billing.userId,
        type: billing.status === "trialing" ? "trial" : "regular",
        status: ["active", "trialing", "past_due"].includes(billing.status)
          ? now >= billing.endsAt
            ? "expired"
            : "active"
          : "revoked",
        startsAt: billing.startsAt,
        endsAt: billing.endsAt,
        updatedAt: billing.updatedAt,
        revision: billing.revision,
        notes: "",
        remindersEnabled: false,
      }
    : null
  const valid = (grant: SubscriptionSummary | null) =>
    grant?.status === "active" && grant.startsAt <= now && grant.endsAt > now
  if (valid(paid) && (!valid(manual) || paid!.endsAt >= manual!.endsAt))
    return { grant: paid, source: "stripe" }
  if (manual) return { grant: manual, source: "manual" }
  return { grant: paid, source: paid ? "stripe" : null }
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
