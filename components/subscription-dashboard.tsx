"use client"

import { DashboardFrame } from "@/components/dashboard-frame"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import {
  ArrowRight,
  ChevronRight,
  LayoutDashboard,
  Search,
  Users,
  UserRound,
  RefreshCw,
  CircleCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { AdminOverview } from "./admin-overview"
import { AdminWaitlist } from "./admin-waitlist"
import { AdminUserProfile, type ProfileDetails } from "./admin-user-profile"
import layout from "./admin-dashboard.module.css"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import type {
  SubscriptionOverview,
  AccountDevice,
  WorkOSUserSummary,
} from "@/lib/subscription-types"
import styles from "./subscription-dashboard.module.css"
type DialogAction = "remove-device" | "details"
type PendingDialog = {
  user: WorkOSUserSummary
  action: DialogAction
  device?: AccountDevice
}
type UserPage = {
  users: WorkOSUserSummary[]
  nextCursor: string | null
  overview: SubscriptionOverview
}
type AccountDetails = ProfileDetails
type Status = "Active" | "Expired" | "Revoked" | "Free account" | "Unavailable"

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}
async function api<T>(
  query = "",
  body?: object,
  signal?: AbortSignal,
  endpoint = "/api/admin/subscriptions"
): Promise<T> {
  const response = await fetch(`${endpoint}${query}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 401)
    throw new ApiError(
      "Your session expired. Sign in in a new tab, then select Refresh.",
      401
    )
  if (response.status === 409)
    throw new ApiError(
      "This account changed while you were editing. Refresh the account before making another change.",
      409
    )
  let result
  try {
    result = await response.json()
  } catch {
    throw new ApiError(
      "Unable to read the server response. Try again.",
      response.status
    )
  }
  if (!response.ok)
    throw new ApiError(
      typeof result?.error === "string"
        ? result.error
        : "Unable to complete this request.",
      response.status
    )
  return result as T
}
function userName(user: WorkOSUserSummary) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
}
function status(user: WorkOSUserSummary): Status {
  if (user.accessUnavailable) return "Unavailable"
  return user.access.status === "active"
    ? "Active"
    : user.access.status === "revoked"
      ? "Revoked"
      : user.access.status === "expired"
        ? "Expired"
        : "Free account"
}
function StatusBadge({ value }: { value: Status }) {
  return (
    <span
      className={
        value === "Active"
          ? styles.active
          : value === "Revoked"
            ? styles.revoked
            : value === "Expired"
              ? styles.expired
              : styles.noSubscription
      }
    >
      {value}
    </span>
  )
}
function ErrorMessage({
  message,
  sessionExpired,
}: {
  message: string
  sessionExpired: boolean
}) {
  return (
    <p role="alert" className={styles.error}>
      {message}{" "}
      {sessionExpired && (
        <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
          Sign in
        </a>
      )}
    </p>
  )
}
function DashboardDialog({
  children,
  onClose,
}: {
  children: ReactNode
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        initialFocus={() =>
          document.querySelector<HTMLElement>("[data-dialog-focus]")
        }
        className={`${styles.modal} ${layout.actionDialog}`}
        showCloseButton={false}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

function mergeUsers(
  previous: WorkOSUserSummary[],
  incoming: WorkOSUserSummary[]
) {
  const users = new Map(previous.map((user) => [user.id, user]))
  for (const user of incoming) users.set(user.id, user)
  return [...users.values()]
}
function validatePage(result: UserPage) {
  if (
    !Array.isArray(result?.users) ||
    !(result.nextCursor === null || typeof result.nextCursor === "string") ||
    !result.overview
  )
    throw new Error("Unable to read subscription data. Try again.")
  return result
}

export function SubscriptionDashboard({
  initialView = "overview",
}: {
  initialView?: string
}) {
  const [view, setView] = useState(
    ["users", "subscriptions"].includes(initialView) ? "accounts" : initialView
  )
  const [profile, setProfile] = useState<WorkOSUserSummary | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [users, setUsers] = useState<WorkOSUserSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [overview, setOverview] = useState<SubscriptionOverview | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [reloadRequired, setReloadRequired] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [dialog, setDialog] = useState<PendingDialog | null>(null)
  const [dialogError, setDialogError] = useState("")
  const [reason, setReason] = useState("")
  const [details, setDetails] = useState<AccountDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const mounted = useRef(false)
  const listRequest = useRef<AbortController | null>(null)
  const detailsRequest = useRef<AbortController | null>(null)
  const pageCount = useRef(1)

  const handleError = useCallback((cause: unknown, inDialog = false) => {
    const message =
      cause instanceof Error
        ? cause.message
        : "Unable to complete this request."
    if (inDialog) setDialogError(message)
    else setError(message)
    if (cause instanceof ApiError && cause.status === 401) {
      setSessionExpired(true)
      setError(message)
    }
    if (cause instanceof ApiError && cause.status === 409)
      setReloadRequired(true)
  }, [])
  const loadUsers = useCallback(
    async (next?: string) => {
      if (listRequest.current) return
      const controller = new AbortController()
      listRequest.current = controller
      try {
        const first = validatePage(
          await api<UserPage>(
            `?${new URLSearchParams({ filter: statusFilter, q: query, ...(next ? { cursor: next } : {}) })}`,
            undefined,
            controller.signal
          )
        )
        let incoming = first.users
        let nextCursor = first.nextCursor
        let pages = 1
        if (!next)
          while (pages < pageCount.current && nextCursor) {
            const page = validatePage(
              await api<UserPage>(
                `?${new URLSearchParams({ filter: statusFilter, q: query, cursor: nextCursor })}`,
                undefined,
                controller.signal
              )
            )
            incoming = mergeUsers(incoming, page.users)
            nextCursor = page.nextCursor
            pages++
          }
        if (!mounted.current || listRequest.current !== controller) return
        setUsers((previous) => mergeUsers(next ? previous : [], incoming))
        setCursor(nextCursor)
        setOverview(first.overview)
        pageCount.current = next ? pageCount.current + 1 : pages
        setHasLoaded(true)
        setLastUpdated(Date.now())
        setError("")
        setSessionExpired(false)
        setReloadRequired(false)
      } catch (cause) {
        if (!controller.signal.aborted && mounted.current) handleError(cause)
      } finally {
        if (listRequest.current === controller) {
          listRequest.current = null
          if (mounted.current) setLoading(false)
        }
      }
    },
    [handleError, statusFilter, query]
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      listRequest.current?.abort()
      detailsRequest.current?.abort()
    }
  }, [])
  useEffect(() => {
    queueMicrotask(() => {
      if (mounted.current) {
        setLoading(true)
        setHasLoaded(false)
        setUsers([])
        setCursor(null)
        pageCount.current = 1
        void loadUsers()
      }
    })
    return () => {
      listRequest.current?.abort()
      listRequest.current = null
    }
  }, [loadUsers])
  useEffect(() => {
    if (dialog || profileId || busy || sessionExpired || reloadRequired) return
    const poll = () => {
      if (document.visibilityState === "visible" && !listRequest.current) {
        setLoading(true)
        void loadUsers()
      }
    }
    const interval = window.setInterval(poll, 30_000)
    document.addEventListener("visibilitychange", poll)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [dialog, profileId, busy, sessionExpired, reloadRequired, loadUsers])
  const loadDetails = useCallback(
    async (user: WorkOSUserSummary | string) => {
      const id = typeof user === "string" ? user : user.id
      detailsRequest.current?.abort()
      const controller = new AbortController()
      detailsRequest.current = controller
      setDetails(null)
      setDetailsLoading(true)
      setDialogError("")
      try {
        const result = await api<AccountDetails>(
          `?userId=${encodeURIComponent(id)}&history=1`,
          undefined,
          controller.signal
        )
        if (
          !Array.isArray(result?.audit) ||
          !Array.isArray(result?.deviceAudit) ||
          !Array.isArray(result?.devices) ||
          !(
            result.subscription === null ||
            typeof result.subscription === "object"
          )
        )
          throw new Error("Unable to read account details. Try again.")
        if (!controller.signal.aborted && mounted.current) {
          setDetails(result)
          const nextUser = result.user
            ? { ...result.user, subscription: result.subscription }
            : typeof user !== "string"
              ? { ...user, subscription: result.subscription }
              : null
          setProfile(nextUser)
          if (!nextUser) throw new Error("This user could not be found.")
          setUsers((current) =>
            current.map((item) => (item.id === id ? nextUser : item))
          )
        }
      } catch (cause) {
        if (!controller.signal.aborted && mounted.current)
          handleError(cause, true)
      } finally {
        if (detailsRequest.current === controller) {
          detailsRequest.current = null
          if (mounted.current) setDetailsLoading(false)
        }
      }
    },
    [handleError]
  )
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])
  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search)
      const target = params.get("view") ?? initialView
      const normalized = ["users", "subscriptions"].includes(target)
        ? "accounts"
        : target
      setView(
        ["overview", "accounts", "waitlist"].includes(normalized)
          ? normalized
          : "overview"
      )
      setProfileId(params.get("user"))
      setStatusFilter(params.get("filter") ?? "all")
    }
    queueMicrotask(sync)
    window.addEventListener("popstate", sync)
    return () => window.removeEventListener("popstate", sync)
  }, [initialView])
  useEffect(() => {
    if (profileId)
      queueMicrotask(() => {
        void loadDetails(profileId)
      })
    return () => {
      detailsRequest.current?.abort()
    }
  }, [profileId, loadDetails])
  const navigate = useCallback((target: string, filter = "all") => {
    setView(target)
    setProfileId(null)
    setProfile(null)
    setDialogError("")
    setStatusFilter(filter)
    setSearch("")
    const params = new URLSearchParams()
    if (target !== "overview") params.set("view", target)
    if (filter !== "all") params.set("filter", filter)
    window.history.pushState(
      null,
      "",
      `/admin${params.size ? `?${params}` : ""}`
    )
  }, [])
  const showProfile = useCallback((user: WorkOSUserSummary | string) => {
    const id = typeof user === "string" ? user : user.id
    setProfile(typeof user === "string" ? null : user)
    setProfileId(id)
    setView("accounts")
    setDialogError("")
    window.history.pushState(
      null,
      "",
      `/admin?view=accounts&user=${encodeURIComponent(id)}`
    )
  }, [])
  const openDialog = useCallback(
    (user: WorkOSUserSummary, action: DialogAction, device?: AccountDevice) => {
      if (action === "details") {
        showProfile(user)
        return
      }
      listRequest.current?.abort()
      listRequest.current = null
      detailsRequest.current?.abort()
      detailsRequest.current = null
      setLoading(false)
      setDialog({ user, action, device })
      setDialogError("")
      setNotice("")
      setReason("")
    },
    [showProfile]
  )
  function closeDialog() {
    if (busy) return
    detailsRequest.current?.abort()
    detailsRequest.current = null
    setDialog(null)
    setDialogError("")
  }
  function refreshAfterConflict() {
    closeDialog()
    setLoading(true)
    setRefreshVersion((value) => value + 1)
    void loadUsers()
    if (profileId) void loadDetails(profileId)
  }
  function changeFilter(value: string) {
    setStatusFilter(value)
    const url = new URL(window.location.href)
    if (value === "all") url.searchParams.delete("filter")
    else url.searchParams.set("filter", value)
    window.history.replaceState(null, "", url)
  }
  function clearFilters() {
    setSearch("")
    changeFilter("all")
  }
  async function mutate(body: object) {
    if (!dialog || busy || sessionExpired || reloadRequired) return
    setBusy(true)
    setDialogError("")
    setError("")
    setNotice("")
    try {
      await api("", body)
      setNotice(`Mac removed for ${dialog.user.email}.`)
      setDialog(null)
      setRefreshVersion((value) => value + 1)
      if (profileId) await loadDetails(profileId)
      setReloadRequired(true)
      setLoading(true)
      await loadUsers()
    } catch (cause) {
      handleError(cause, true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (!dialog) return
    void mutate({
      action: dialog.action,
      userId: dialog.user.id,
      reason: reason.trim(),
      sessionId: dialog.device?.sessionId,
      expectedSessionRevision: dialog.device?.revision,
    })
  }
  const actionsDisabled = busy || sessionExpired || reloadRequired || !hasLoaded
  const filteredUsers = users
  const filtersActive = !!search || statusFilter !== "all"
  function accountActions(user: WorkOSUserSummary, inDetails = false) {
    return (
      <div className={styles.rowActions}>
        {!inDetails && (
          <Button
            variant="outline"
            type="button"
            disabled={busy || sessionExpired}
            onClick={() => openDialog(user, "details")}
            aria-label={`View ${user.email}`}
          >
            Details
          </Button>
        )}
        {inDetails && <p>Subscriptions and discounts are managed in Stripe.</p>}
      </div>
    )
  }
  const titles: Record<string, string> = {
    overview: "Overview",
    accounts: "Accounts",
    waitlist: "Waitlist",
  }
  const navigation = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "accounts", label: "Accounts", icon: UserRound },
    { id: "waitlist", label: "Waitlist", icon: Users },
  ]
  const filterOptions = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "standard", label: "Standard" },
    { value: "expired", label: "Expired" },
    { value: "revoked", label: "Revoked" },
    { value: "unassigned", label: "Free accounts" },
  ]
  return (
    <DashboardFrame
      mode="admin"
      className={layout.workspace}
      disabled={busy}
      items={navigation.map(({ id, label, icon: Icon }) => ({
        title: label,
        icon: <Icon size={17} />,
        isActive: view === id,
        onSelect: () => navigate(id),
        badge: id === "waitlist" ? overview?.waitlistTotal : undefined,
      }))}
    >
      <header className={layout.topbar}>
        <div>
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          Admin
          <ChevronRight size={13} />
          <strong>{titles[view]}</strong>
          {profileId && (
            <>
              <ChevronRight size={13} />
              <span>User management</span>
            </>
          )}
        </div>
        <span className={layout.ownerBadge}>
          <ShieldIcon />
          Owner access
        </span>
      </header>
      <div className={`${styles.page} ${layout.content}`}>
        <div className={layout.pageHeading}>
          <div>
            <h1>{profileId ? "User management" : titles[view]}</h1>
          </div>
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              setRefreshVersion((value) => value + 1)
              setLoading(true)
              void loadUsers()
              if (profileId) void loadDetails(profileId)
            }}
            disabled={loading || busy}
          >
            <RefreshCw className={loading ? layout.spinning : ""} />
            {loading && hasLoaded ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {error && (
          <ErrorMessage message={error} sessionExpired={sessionExpired} />
        )}
        {notice && (
          <p className={styles.notice} role="status">
            <CircleCheck size={16} />
            {notice}
          </p>
        )}
        {reloadRequired && !dialog && (
          <p role="alert" className={styles.error}>
            Refresh subscription data before making another change.
          </p>
        )}
        {profileId ? (
          profile ? (
            <AdminUserProfile
              user={profile}
              details={details}
              loading={detailsLoading}
              error={dialogError}
              actions={accountActions(profile, true)}
              onBack={() => navigate("accounts")}
              onRetry={() => void loadDetails(profileId)}
              onRemove={(device) =>
                openDialog(profile, "remove-device", device)
              }
              disabled={actionsDisabled || detailsLoading || !!dialogError}
            />
          ) : (
            <div className={layout.empty}>
              <UserRound size={30} />
              <strong>{dialogError || "Loading user…"}</strong>
              <Button variant="outline" onClick={() => navigate("accounts")}>
                Back to accounts
              </Button>
              {dialogError && (
                <Button onClick={() => void loadDetails(profileId)}>
                  Retry details
                </Button>
              )}
            </div>
          )
        ) : (
          <>
            {view === "overview" && (
              <AdminOverview overview={overview} navigate={navigate} />
            )}
            {view === "waitlist" && (
              <AdminWaitlist refreshVersion={refreshVersion} />
            )}
            {(view === "accounts" || view === "overview") && (
              <section
                className={layout.tableCard}
                aria-label="Accounts"
                aria-busy={loading}
              >
                <div className={layout.tableHeading}>
                  <div>
                    <h2>
                      {view === "overview"
                        ? "Recent accounts"
                        : "Account directory"}
                    </h2>
                  </div>
                  {view === "overview" ? (
                    <Button
                      variant="outline"
                      onClick={() => navigate("accounts")}
                    >
                      View all accounts
                      <ArrowRight />
                    </Button>
                  ) : (
                    <Badge variant="secondary">
                      {users.length}
                      {cursor ? "+" : ""} accounts
                    </Badge>
                  )}
                </div>
                {view !== "overview" && (
                  <>
                    <Tabs
                      value={statusFilter}
                      onValueChange={(value) => changeFilter(String(value))}
                      className={layout.filterTabs}
                    >
                      <TabsList variant="line">
                        {filterOptions.map((option) => (
                          <TabsTrigger key={option.value} value={option.value}>
                            {option.label}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </Tabs>
                    <div className={layout.tableToolbar}>
                      <div className={layout.searchBox}>
                        <Search size={16} />
                        <Input
                          type="search"
                          aria-label="Search accounts"
                          placeholder="Search name, email, account ID, or notes…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </div>
                      <div className={layout.toolbarActions}>
                        {filtersActive && (
                          <Button variant="ghost" onClick={clearFilters}>
                            Clear filters
                          </Button>
                        )}
                      </div>
                    </div>
                  </>
                )}
                <div className={layout.accountTable}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Offline access valid until</TableHead>
                        <TableHead>Macs</TableHead>
                        <TableHead className={layout.actionsColumn}>
                          Manage
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(view === "overview"
                        ? filteredUsers.slice(0, 5)
                        : filteredUsers
                      ).map((user) => (
                        <TableRow key={user.id}>
                          <TableCell>
                            <button
                              className={layout.accountName}
                              onClick={() => openDialog(user, "details")}
                            >
                              <span className={layout.avatar}>
                                {userName(user).slice(0, 1).toUpperCase()}
                              </span>
                              <span>
                                <strong>{userName(user)}</strong>
                                <small>{user.email}</small>
                                {!user.emailVerified && (
                                  <small className={layout.unverified}>
                                    Email not verified
                                  </small>
                                )}
                              </span>
                            </button>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {user.accessUnavailable
                                ? "Unknown"
                                : user.access.tier === "trial"
                                  ? "Trial"
                                  : user.access.tier === "standard"
                                    ? "Standard"
                                    : "Free"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <StatusBadge value={status(user)} />
                          </TableCell>
                          <TableCell>
                            {!user.accessUnavailable &&
                            user.access.endsAt != null ? (
                              <>
                                <span>
                                  {new Date(
                                    user.access.endsAt
                                  ).toLocaleDateString(undefined, {
                                    dateStyle: "medium",
                                  })}
                                </span>
                                <small className={layout.cellSecondary}>
                                  Offline access deadline
                                </small>
                              </>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell>{user.devices.length} / 2</TableCell>
                          <TableCell>{accountActions(user)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {!filteredUsers.length && (
                  <div className={layout.empty}>
                    <Users size={28} />
                    <strong>
                      {loading
                        ? "Loading accounts…"
                        : !hasLoaded
                          ? "The account list is unavailable"
                          : filtersActive
                            ? "No matching accounts"
                            : "No accounts yet"}
                    </strong>
                    {!loading && cursor && (
                      <p>More accounts are available on the next page.</p>
                    )}
                  </div>
                )}
                <div className={layout.tableFooter}>
                  <span role="status">
                    {hasLoaded
                      ? `${view === "overview" ? Math.min(5, users.length) : users.length} accounts shown${cursor ? " · More results available" : ""}`
                      : "Loading account list…"}
                    {lastUpdated && (
                      <small>
                        Updated{" "}
                        {new Date(lastUpdated).toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </small>
                    )}
                  </span>
                  {cursor && view !== "overview" && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setLoading(true)
                        void loadUsers(cursor)
                      }}
                      disabled={loading || busy || sessionExpired}
                    >
                      {loading ? "Loading…" : "Load more accounts"}
                    </Button>
                  )}
                </div>
              </section>
            )}
          </>
        )}
        {dialog && (
          <DashboardDialog
            key={`${dialog.user.id}-${dialog.action}`}
            onClose={closeDialog}
          >
            <DialogTitle>Remove Mac?</DialogTitle>
            <p className={styles.dialogAccount}>{dialog.user.email}</p>
            {dialogError && (
              <ErrorMessage
                message={dialogError}
                sessionExpired={sessionExpired}
              />
            )}
            {reloadRequired && (
              <Button onClick={refreshAfterConflict} disabled={busy}>
                Refresh account data
              </Button>
            )}
            <form onSubmit={save}>
              <p>
                Sign out {dialog.device?.deviceName || "this Mac"}. It must sign
                in again to reconnect.
              </p>
              <label>
                Reason for this change{" "}
                <span className={styles.optional}>
                  Optional · recorded in activity history
                </span>
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={1000}
                  rows={2}
                  disabled={busy}
                />
              </label>
              <div className={styles.actions}>
                <Button type="submit" disabled={actionsDisabled}>
                  {busy ? "Saving…" : "Remove Mac"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDialog}
                  disabled={busy}
                  data-dialog-focus
                >
                  Cancel
                </Button>
              </div>
            </form>
          </DashboardDialog>
        )}
      </div>
    </DashboardFrame>
  )
}
function ShieldIcon() {
  return <CircleCheck size={13} />
}
