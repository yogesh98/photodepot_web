import type { Env } from "./cloudflare.ts"
import { listAccountDevicesForUsers } from "./account-sessions.ts"
import { listAccountEntitlements } from "./account-entitlement.ts"
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
  const active = user.access.canUseLocal
  const filtered =
    filter === "all" ||
    (filter === "active" && active) ||
    (filter === "trial" && active && user.access.tier === "trial") ||
    (filter === "standard" && active && user.access.tier === "standard") ||
    (filter === "expiring" &&
      active &&
      user.access.source === "manual" &&
      user.access.endsAt !== null &&
      user.access.endsAt <= now + 7 * 86_400_000) ||
    (filter === "expired" && user.access.status === "expired") ||
    (filter === "revoked" && user.access.status === "revoked") ||
    (filter === "unassigned" && user.access.source === null)
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
  // Each account can refresh independent WorkOS credentials and run receipt CAS
  // queries. Bound hydrated accounts as well as provider pages so filtered scans
  // stay within the Free plan's subrequest budget.
  let remainingUsers = 20
  for (let scannedPages = 0; scannedPages < 10; scannedPages++) {
    const page = await listWorkOSUsers(env, cursor)
    const selectedUsers = page.users.slice(0, remainingUsers)
    remainingUsers -= selectedUsers.length
    const userIds = selectedUsers.map((user) => user.id)
    const [entitlements, deviceLists] = await Promise.all([
      listAccountEntitlements(env, userIds, now),
      listAccountDevicesForUsers(env.DB, userIds),
    ])
    for (const user of selectedUsers) {
      const summary = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: user.emailVerified,
        createdAt: Date.parse(user.createdAt),
        subscription: entitlements.get(user.id)!.manual,
        billing: entitlements.get(user.id)!.billing,
        managed: entitlements.get(user.id)!.managed,
        access: entitlements.get(user.id)!.access,
        devices: deviceLists.get(user.id) ?? [],
      }
      if (matches(summary, filter, search, now)) users.push(summary)
    }
    // WorkOS may have returned additional users even on its final page. Resume
    // after the last account we actually processed, including empty match pages.
    const nextCursor =
      selectedUsers.length < page.users.length
        ? selectedUsers.at(-1)!.id
        : page.nextCursor
    if (!nextCursor) return { users, nextCursor: null }
    if (seenCursors.has(nextCursor) || nextCursor === cursor)
      throw new Error("User directory pagination did not advance")
    seenCursors.add(nextCursor)
    cursor = nextCursor
    // Preserve ordinary directory pagination; scans are only needed for searches.
    if (remainingUsers === 0 || (filter === "all" && !search))
      return { users, nextCursor: cursor }
  }
  return { users, nextCursor: cursor ?? null }
}
