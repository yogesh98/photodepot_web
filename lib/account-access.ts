import { LICENSE_GRACE_MS } from "./license-crypto.ts"
import type {
  AccountAccess,
  WorkOSEntitlementSummary,
  SubscriptionSummary,
} from "./subscription-types.ts"

/** Subscription entitlements alone grant access. Legacy manual rows are history only. */
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

/** Preserve the legacy argument only for callers displaying stored grant history. */
export function selectAccountGrant(
  manual: SubscriptionSummary | null,
  managed: WorkOSEntitlementSummary | null,
  now = Date.now()
): { grant: SubscriptionSummary | null; source: AccountAccess["source"] } {
  void manual
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
  return { grant: paid, source: paid ? "workos" : null }
}
