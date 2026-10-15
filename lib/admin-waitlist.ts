import type { D1Database } from "@cloudflare/workers-types"

export interface AdminWaitlistEntry {
  id: number
  firstName: string
  lastName: string | null
  email: string
  heardAboutUs: string
  createdAt: number
}
export interface AdminWaitlistOverview {
  total: number
  last30Days: number
  sources: { source: string; count: number }[]
  asOf: number
}
export interface AdminWaitlistPage {
  entries: AdminWaitlistEntry[]
  nextCursor: string | null
  totalMatches: number
  overview: AdminWaitlistOverview
}

export async function listAdminWaitlist(
  database: D1Database,
  query: URLSearchParams,
  now = Date.now()
): Promise<AdminWaitlistPage> {
  const search = (query.get("q") ?? "").trim().toLowerCase()
  const suppliedCursor = query.get("cursor")
  const cursor = suppliedCursor === null ? null : Number(suppliedCursor)
  if (
    search.length > 200 ||
    (cursor !== null &&
      (!/^\d+$/.test(suppliedCursor!) ||
        !Number.isSafeInteger(cursor) ||
        cursor < 1))
  )
    throw new TypeError("Invalid waitlist search or page.")
  const match =
    "(? = '' OR instr(lower(first_name || ' ' || coalesce(last_name, '') || ' ' || email || ' ' || heard_about_us), ?) > 0)"
  const [rows, count, totals, sources] = await Promise.all([
    database
      .prepare(
        `SELECT id, first_name AS firstName, last_name AS lastName, email,
      heard_about_us AS heardAboutUs, created_at AS createdAt FROM waitlist WHERE ${match}
      AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 51`
      )
      .bind(search, search, cursor, cursor)
      .all<Omit<AdminWaitlistEntry, "createdAt"> & { createdAt: string }>(),
    database
      .prepare(`SELECT COUNT(*) AS count FROM waitlist WHERE ${match}`)
      .bind(search, search)
      .first<{ count: number }>(),
    database
      .prepare(
        `SELECT COUNT(*) AS total, coalesce(sum(julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)), 0) AS last30Days FROM waitlist`
      )
      .bind(
        new Date(Math.max(0, now - 30 * 86_400_000)).toISOString(),
        new Date(now).toISOString()
      )
      .first<{ total: number; last30Days: number }>(),
    database
      .prepare(
        "SELECT heard_about_us AS source, COUNT(*) AS count FROM waitlist GROUP BY heard_about_us ORDER BY count DESC, source LIMIT 12"
      )
      .all<{ source: string; count: number }>(),
  ])
  const entries = rows.results
    .slice(0, 50)
    .map((row) => ({ ...row, createdAt: Date.parse(row.createdAt) }))
  return {
    entries,
    nextCursor: rows.results.length > 50 ? String(entries.at(-1)!.id) : null,
    totalMatches: count?.count ?? 0,
    overview: {
      total: totals?.total ?? 0,
      last30Days: totals?.last30Days ?? 0,
      sources: sources.results,
      asOf: now,
    },
  }
}
