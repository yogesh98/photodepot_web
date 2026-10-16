import { resolveAccountAccess } from "./account-access.ts"
import { getAccountEntitlement } from "./account-entitlement.ts"
import type { Env } from "./cloudflare.ts"
import { getSubscription } from "./subscription-store.ts"

/** Admin display may retain account management while authorization is unavailable. */
export async function getAdminEntitlement(
  env: Env,
  userId: string,
  now = Date.now()
) {
  try {
    const { manual, managed, billing, access } = await getAccountEntitlement(
      env,
      userId,
      now
    )
    return { manual, managed, billing, access, accessUnavailable: false }
  } catch {
    // Keep historical notes and audits accessible, but never turn a failed
    // verification into either a paid grant or a confirmed free-account label.
    return {
      manual: await getSubscription(env.DB, userId, now),
      managed: null,
      billing: null,
      access: resolveAccountAccess(null, now),
      accessUnavailable: true,
    }
  }
}

export async function listAdminEntitlements(
  env: Env,
  userIds: string[],
  now = Date.now()
) {
  const results = new Map<
    string,
    Awaited<ReturnType<typeof getAdminEntitlement>>
  >()
  const started = Date.now()
  const uniqueIds = [...new Set(userIds)]
  for (let offset = 0; offset < uniqueIds.length; offset += 10) {
    await Promise.all(
      uniqueIds.slice(offset, offset + 10).map(async (userId) => {
        results.set(
          userId,
          await getAdminEntitlement(
            env,
            userId,
            now + Math.max(0, Date.now() - started)
          )
        )
      })
    )
  }
  return results
}
