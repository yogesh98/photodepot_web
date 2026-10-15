"use client"

import { useEffect, useRef, useState } from "react"
import { Download, Search, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import styles from "./admin-dashboard.module.css"

type Entry = {
  id: number
  firstName: string
  lastName: string | null
  email: string
  heardAboutUs: string
  createdAt: number
}
type Page = {
  entries: Entry[]
  nextCursor: string | null
  totalMatches: number
  overview: {
    total: number
    last30Days: number
    sources: { source: string; count: number }[]
    asOf: number
  }
}
export function AdminWaitlist({
  refreshVersion = 0,
}: {
  refreshVersion?: number
}) {
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [data, setData] = useState<Page | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [expired, setExpired] = useState(false)
  const [reload, setReload] = useState(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  async function load(cursor?: string, signal?: AbortSignal) {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({
        q: query,
        ...(cursor ? { cursor } : {}),
      })
      const response = await fetch(`/api/admin/waitlist?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      })
      if (response.status === 401) {
        setExpired(true)
        throw new Error(
          "Your session expired. Sign in, then refresh the waitlist."
        )
      }
      const result = await response.json()
      if (!response.ok) {
        setExpired(response.status === 401)
        throw new Error(result.error || "Unable to load waitlist signups.")
      }
      if (!Array.isArray(result.entries) || !result.overview)
        throw new Error("Unable to read the waitlist. Try again.")
      if (!signal?.aborted) {
        setData((previous) => ({
          ...result,
          entries: cursor
            ? [...(previous?.entries ?? []), ...result.entries]
            : result.entries,
        }))
        setExpired(false)
      }
    } catch (cause) {
      if (!signal?.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load the waitlist."
        )
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setData(null)
        void load(undefined, controller.signal)
      }
    })
    return () => controller.abort()
    // Each search starts a new server-side result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, reload, refreshVersion])
  function exportCsv() {
    if (!data) return
    const safe = (value: string) =>
      `"${(/^[\s]*[=+@-]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`
    const rows = [
      ["First name", "Last name", "Email", "Source", "Joined"],
      ...data.entries.map((e) => [
        e.firstName,
        e.lastName ?? "",
        e.email,
        e.heardAboutUs,
        new Date(e.createdAt).toISOString(),
      ]),
    ]
    const url = URL.createObjectURL(
      new Blob([rows.map((row) => row.map(safe).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "photodepot-waitlist.csv"
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section aria-label="Waitlist signups" aria-busy={loading}>
      <div className={styles.waitlistSummary}>
        <div>
          <span>Total signups</span>
          <strong>{data?.overview.total ?? "—"}</strong>
        </div>
        <div>
          <span>Last 30 days</span>
          <strong>{data?.overview.last30Days ?? "—"}</strong>
        </div>
        <div className={styles.sources}>
          <span>Signup sources</span>
          <p>
            {data?.overview.sources.length
              ? data.overview.sources.slice(0, 4).map((source) => (
                  <Badge key={source.source} variant="secondary">
                    {source.source} · {source.count}
                  </Badge>
                ))
              : "No sources yet."}
          </p>
        </div>
      </div>
      <div className={styles.tableCard}>
        <div className={styles.tableToolbar}>
          <div className={styles.searchBox}>
            <Search size={16} />
            <Input
              type="search"
              aria-label="Search waitlist"
              placeholder="Search name, email, or source…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className={styles.toolbarActions}>
            <Button
              variant="outline"
              onClick={() => setReload((n) => n + 1)}
              disabled={loading}
            >
              Refresh waitlist
            </Button>
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={!data?.entries.length || loading}
            >
              <Download />
              Export loaded ({data?.entries.length ?? 0})
            </Button>
          </div>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}{" "}
            {expired && (
              <a
                href="/api/auth/login"
                target="_blank"
                rel="noopener noreferrer"
              >
                Sign in
              </a>
            )}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email address</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>
                  <strong>
                    {[entry.firstName, entry.lastName]
                      .filter(Boolean)
                      .join(" ")}
                  </strong>
                </TableCell>
                <TableCell>{entry.email}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{entry.heardAboutUs}</Badge>
                </TableCell>
                <TableCell>
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    dateStyle: "medium",
                  })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!data?.entries.length && !error && (
          <div className={styles.empty}>
            <Users size={28} />
            <strong>
              {loading
                ? "Loading signups…"
                : query
                  ? "No matching signups"
                  : "No signups yet"}
            </strong>
          </div>
        )}
        <div className={styles.tableFooter}>
          <span>
            {data
              ? `${data.entries.length} of ${data.totalMatches} matching signups`
              : "Waitlist signups"}
          </span>
          {data?.nextCursor && (
            <Button
              variant="outline"
              disabled={loading}
              onClick={() =>
                void load(data.nextCursor!, request.current?.signal)
              }
            >
              {loading ? "Loading…" : "Load more signups"}
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
