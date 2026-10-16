import { LICENSE_GRACE_MS } from "./license-crypto.ts"
import type {
  AccountAccess,
  WorkOSEntitlementSummary,
  SubscriptionSummary,
} from "./subscription-types.ts"

/** The only grant-dependent access decision. Device and identity checks are separate. */
export function resolveAccountAccess(
  grant: SubscriptionSummary | null,
  now = Date.now(),
  managed: WorkOSEntitlementSummary | null = null
): AccountAccess {
  const selected = selectAccountGrant(grant, managed, now)
  grant = selected.grant
  const status = !grant
    ? "none"
    : grant.status === "revoked"
      ? "revoked"
      : grant.status === "expired" || now >= grant.endsAt
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

/** Manual grants remain independent; WorkOS proves paid feature access. */
export function selectAccountGrant(
  manual: SubscriptionSummary | null,
  managed: WorkOSEntitlementSummary | null,
  now = Date.now()
): { grant: SubscriptionSummary | null; source: AccountAccess["source"] } {
  const paid: SubscriptionSummary | null = managed?.enabled
    ? {
        id: `workos:${managed.userId}`,
        userId: managed.userId,
        type: "regular",
        status: managed.expiresAt <= now ? "expired" : "active",
        startsAt: managed.issuedAt,
        // This is our fixed offline authorization allowance, never a renewal date.
        endsAt: managed.issuedAt + LICENSE_GRACE_MS,
        updatedAt: managed.issuedAt,
        revision: managed.revision,
        notes: "",
        remindersEnabled: false,
      }
    : null
  const valid = (grant: SubscriptionSummary | null) =>
    grant?.status === "active" && grant.startsAt <= now && grant.endsAt > now
  if (valid(paid) && (!valid(manual) || paid!.endsAt >= manual!.endsAt))
    return { grant: paid, source: "workos" }
  if (manual) return { grant: manual, source: "manual" }
  return { grant: paid, source: paid ? "workos" : null }
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
