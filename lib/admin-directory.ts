import type { Env } from "./cloudflare.ts"
import { resolveAccountAccess } from "./account-access.ts"
import { listAccountDevicesForUsers } from "./account-sessions.ts"
import { listSubscriptions } from "./subscription-store.ts"
import type { WorkOSUserSummary } from "./subscription-types.ts"
import { listWorkOSUsers, WORKOS_USER_ID } from "./workos-users.ts"

export const ADMIN_USER_FILTERS = [
  "all",
  "active",
  "trial",
  "standard",
  "expiring",
  "expired",
  "revoked",
  "unassigned",
] as const
export type AdminUserFilter = (typeof ADMIN_USER_FILTERS)[number]

function matches(
  user: WorkOSUserSummary,
  filter: AdminUserFilter,
  search: string,
  now: number
) {
  const subscription = user.subscription
  const active = subscription?.status === "active"
  const filtered =
    filter === "all" ||
    (filter === "active" && active) ||
    (filter === "trial" && active && subscription.type === "trial") ||
    (filter === "standard" && active && subscription.type === "regular") ||
    (filter === "expiring" &&
      active &&
      subscription.endsAt <= now + 7 * 86_400_000) ||
    (filter === "expired" && subscription?.status === "expired") ||
    (filter === "revoked" && subscription?.status === "revoked") ||
    (filter === "unassigned" && !subscription)
  return (
    filtered &&
    (!search ||
      [
        user.id,
        user.email,
        user.firstName,
        user.lastName,
        `${user.firstName ?? ""} ${user.lastName ?? ""}`,
        subscription?.notes,
      ].some((value) => value?.toLowerCase().includes(search)))
  )
}

/** Filters on the server and carries the provider cursor forward, including across empty pages. */
export async function listAdminUsers(
  env: Env,
  query: URLSearchParams,
  now = Date.now()
) {
  const filter = (query.get("filter") ?? "all") as AdminUserFilter
  const search = (query.get("q") ?? "").trim().toLowerCase()
  let cursor = query.get("cursor") || undefined
  if (
    !ADMIN_USER_FILTERS.includes(filter) ||
    search.length > 200 ||
    (cursor && !WORKOS_USER_ID.test(cursor))
  )
    throw new TypeError("Invalid user filter, search or page.")
  const users: WorkOSUserSummary[] = []
  const seenCursors = new Set<string>()
  // Bound provider work per request. A continuation is always returned when more
  // source rows exist, even if none in these pages match. No client-only filtering.
  for (let scannedPages = 0; scannedPages < 10; scannedPages++) {
    const page = await listWorkOSUsers(env, cursor)
    const userIds = page.users.map((user) => user.id)
    const [subscriptions, deviceLists] = await Promise.all([
      listSubscriptions(env.DB, userIds, now),
      listAccountDevicesForUsers(env.DB, userIds),
    ])
    for (let index = 0; index < page.users.length; index++) {
      const user = page.users[index]
      const summary = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: user.emailVerified,
        createdAt: Date.parse(user.createdAt),
        subscription: subscriptions.get(user.id) ?? null,
        access: resolveAccountAccess(subscriptions.get(user.id) ?? null, now),
        devices: deviceLists.get(user.id) ?? [],
      }
      if (matches(summary, filter, search, now)) users.push(summary)
      if (users.length === 100)
        return {
          users,
          nextCursor:
            index < page.users.length - 1 || page.nextCursor ? user.id : null,
        }
    }
    if (!page.nextCursor) return { users, nextCursor: null }
    if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor)
      throw new Error("User directory pagination did not advance")
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
    // Preserve ordinary directory pagination; scans are only needed for searches.
    if (filter === "all" && !search) return { users, nextCursor: cursor }
  }
  return { users, nextCursor: cursor ?? null }
}
