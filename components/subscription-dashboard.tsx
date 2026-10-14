"use client"

import Link from "next/link"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import type {
  SubscriptionAudit,
  SubscriptionDeviceHistory,
  SubscriptionOverview,
  SubscriptionSummary,
  SubscriptionType,
  WorkOSUserSummary,
} from "@/lib/subscription-types"
import styles from "./subscription-dashboard.module.css"

const day = 86_400_000
const durationPresets = [7, 14, 30, 90, 365]
type DialogAction =
  | "set"
  | "extend"
  | "revoke"
  | "restore"
  | "reset-device"
  | "update-notes"
  | "details"
type PendingDialog = { user: WorkOSUserSummary; action: DialogAction }
type UserPage = {
  users: WorkOSUserSummary[]
  nextCursor: string | null
  environment: "production" | "development"
  overview: SubscriptionOverview
}
type AccountDetails = {
  subscription: SubscriptionSummary | null
  audit: SubscriptionAudit[]
  devices: SubscriptionDeviceHistory[]
}
type Status = "Active" | "Expired" | "Revoked" | "No subscription"

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
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(`/api/admin/subscriptions${query}`, {
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
function fullDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(value)
}
function shortDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value)
}
function localDate(value: number) {
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}
function userName(user: WorkOSUserSummary) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
}
function subscriptionType(type: SubscriptionType) {
  return type === "trial" ? "Trial" : "Standard"
}
function status(user: WorkOSUserSummary, now: number): Status {
  const subscription = user.subscription
  if (!subscription) return "No subscription"
  if (subscription.status === "revoked") return "Revoked"
  return subscription.endsAt <= now || subscription.status === "expired"
    ? "Expired"
    : "Active"
}
function remaining(endsAt: number, now: number) {
  const days = Math.ceil((endsAt - now) / day)
  return days <= 0
    ? "Expiry has passed"
    : days === 1
      ? "Less than 24 hours left"
      : `${days} days left`
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
function DateTime({ value }: { value: number }) {
  return (
    <time dateTime={new Date(value).toISOString()} title={fullDate(value)}>
      {shortDate(value)}
    </time>
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
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    const previouslyFocused = document.activeElement as HTMLElement | null
    element?.showModal()
    element?.querySelector<HTMLElement>("[data-dialog-focus]")?.focus()
    return () => {
      element?.close()
      previouslyFocused?.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.overlay}
      aria-labelledby="subscription-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']"
          )
        ).filter((element) => element.getClientRects().length > 0)
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === event.currentTarget)
        ) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <section className={styles.modal}>{children}</section>
    </dialog>
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
    !["production", "development"].includes(result.environment) ||
    !result.overview
  )
    throw new Error("Unable to read subscription data. Try again.")
  return result
}

export function SubscriptionDashboard() {
  const [users, setUsers] = useState<WorkOSUserSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [overview, setOverview] = useState<SubscriptionOverview | null>(null)
  const [environment, setEnvironment] = useState<
    UserPage["environment"] | null
  >(null)
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
  const [typeFilter, setTypeFilter] = useState("all")
  const [expiryFilter, setExpiryFilter] = useState("all")
  const [sort, setSort] = useState("newest")
  const [dialog, setDialog] = useState<PendingDialog | null>(null)
  const [dialogError, setDialogError] = useState("")
  const [selectedType, setSelectedType] = useState<SubscriptionType>("trial")
  const [expiryMode, setExpiryMode] = useState("duration")
  const [durationPreset, setDurationPreset] = useState("7")
  const [customDays, setCustomDays] = useState("7")
  const [customExpiry, setCustomExpiry] = useState("")
  const [reason, setReason] = useState("")
  const [notes, setNotes] = useState("")
  const [previewNow, setPreviewNow] = useState(0)
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
            next ? `?cursor=${encodeURIComponent(next)}` : "",
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
                `?cursor=${encodeURIComponent(nextCursor)}`,
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
        setEnvironment(first.environment)
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
    [handleError]
  )
  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => {
      if (mounted.current) void loadUsers()
    })
    return () => {
      mounted.current = false
      listRequest.current?.abort()
      listRequest.current = null
      detailsRequest.current?.abort()
    }
  }, [loadUsers])
  useEffect(() => {
    if (dialog || busy || sessionExpired || reloadRequired) return
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
  }, [dialog, busy, sessionExpired, reloadRequired, loadUsers])
  useEffect(() => {
    if (!dialog || !["set", "extend"].includes(dialog.action)) return
    const interval = window.setInterval(() => setPreviewNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [dialog])

  const loadDetails = useCallback(
    async (user: WorkOSUserSummary) => {
      detailsRequest.current?.abort()
      const controller = new AbortController()
      detailsRequest.current = controller
      setDetails(null)
      setDetailsLoading(true)
      setDialogError("")
      try {
        const result = await api<AccountDetails>(
          `?userId=${encodeURIComponent(user.id)}&history=1`,
          undefined,
          controller.signal
        )
        if (
          !Array.isArray(result?.audit) ||
          !Array.isArray(result?.devices) ||
          !(
            result.subscription === null ||
            typeof result.subscription === "object"
          )
        )
          throw new Error("Unable to read account details. Try again.")
        if (!controller.signal.aborted && mounted.current) {
          setDetails(result)
          setDialog((current) =>
            current?.user.id === user.id
              ? {
                  ...current,
                  user: { ...current.user, subscription: result.subscription },
                }
              : current
          )
          setUsers((current) =>
            current.map((item) =>
              item.id === user.id
                ? { ...item, subscription: result.subscription }
                : item
            )
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
  const openDialog = useCallback(
    (user: WorkOSUserSummary, action: DialogAction) => {
      listRequest.current?.abort()
      listRequest.current = null
      detailsRequest.current?.abort()
      detailsRequest.current = null
      setLoading(false)
      setDialog({ user, action })
      setDialogError("")
      setNotice("")
      setPreviewNow(Date.now())
      setSelectedType(user.subscription?.type ?? "trial")
      const days = user.subscription?.type === "regular" ? "30" : "7"
      setDurationPreset(days)
      setCustomDays(days)
      setExpiryMode("duration")
      setCustomExpiry(
        localDate(
          Math.max(Date.now(), user.subscription?.endsAt ?? 0) +
            Number(days) * day
        )
      )
      setReason("")
      setNotes(user.subscription?.notes ?? "")
      setDetails(null)
      if (action === "details") void loadDetails(user)
    },
    [loadDetails]
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
    void loadUsers()
  }
  function clearFilters() {
    setSearch("")
    setStatusFilter("all")
    setTypeFilter("all")
    setExpiryFilter("all")
  }
  const durationDays = Number(
    durationPreset === "custom" ? customDays : durationPreset
  )
  const validDuration =
    Number.isInteger(durationDays) && durationDays >= 1 && durationDays <= 3650
  const expiryBase =
    dialog?.action === "extend"
      ? Math.max(previewNow, dialog.user.subscription?.endsAt ?? previewNow)
      : previewNow
  const explicitExpiry = customExpiry ? new Date(customExpiry).getTime() : NaN
  const validExplicitExpiry =
    Number.isSafeInteger(explicitExpiry) &&
    explicitExpiry > expiryBase &&
    explicitExpiry <= previewNow + 3650 * day
  const expiryPreview =
    expiryMode === "date"
      ? validExplicitExpiry
        ? explicitExpiry
        : null
      : validDuration
        ? expiryBase + durationDays * day
        : null
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !dialog ||
      busy ||
      sessionExpired ||
      reloadRequired ||
      dialog.action === "details"
    )
      return
    const timed = dialog.action === "set" || dialog.action === "extend"
    if (timed && !expiryPreview) {
      setDialogError(
        expiryMode === "date"
          ? `Choose an expiry after ${dialog.action === "extend" ? "the current expiry or now, whichever is later" : "now"}, within the next 10 years.`
          : "Enter a whole number of days from 1 to 3,650."
      )
      return
    }
    setBusy(true)
    setDialogError("")
    setError("")
    setNotice("")
    try {
      const result = await api<{ subscription: SubscriptionSummary }>("", {
        action: dialog.action,
        userId: dialog.user.id,
        expectedRevision: dialog.user.subscription?.revision ?? 0,
        reason: reason.trim(),
        ...(timed
          ? expiryMode === "date"
            ? { endsAt: explicitExpiry }
            : { durationDays }
          : {}),
        ...(dialog.action === "set" ? { type: selectedType, notes } : {}),
        ...(dialog.action === "update-notes" ? { notes } : {}),
      })
      setUsers((current) =>
        current.map((user) =>
          user.id === dialog.user.id
            ? { ...user, subscription: result.subscription }
            : user
        )
      )
      setNotice(
        `${dialog.action === "revoke" ? "Access revoked" : dialog.action === "restore" ? "Subscription restored; its expiry is unchanged" : dialog.action === "reset-device" ? "Mac assignment reset; this account can sign in on another Mac" : dialog.action === "update-notes" ? "Account notes saved" : dialog.action === "extend" ? "Subscription extended" : "Subscription saved"} for ${dialog.user.email}.`
      )
      setDialog(null)
      setReloadRequired(true)
      setLoading(true)
      await loadUsers()
    } catch (cause) {
      handleError(cause, true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const actionsDisabled = busy || sessionExpired || reloadRequired || !hasLoaded
  const now = lastUpdated ?? 0
  const filteredUsers = users
    .filter((user) => {
      const currentStatus = status(user, now)
      const matchesSearch = [
        userName(user),
        user.email,
        user.id,
        user.subscription?.notes ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.trim().toLowerCase())
      return (
        matchesSearch &&
        (statusFilter === "all" || currentStatus === statusFilter) &&
        (typeFilter === "all" || user.subscription?.type === typeFilter) &&
        (expiryFilter === "all" ||
          (currentStatus === "Active" &&
            !!user.subscription &&
            user.subscription.endsAt <= now + Number(expiryFilter) * day))
      )
    })
    .sort((a, b) =>
      sort === "email"
        ? a.email.localeCompare(b.email)
        : sort === "expiry"
          ? (a.subscription?.endsAt ?? Infinity) -
            (b.subscription?.endsAt ?? Infinity)
          : b.createdAt - a.createdAt
    )
  const filtersActive =
    !!search ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    expiryFilter !== "all"
  function accountActions(user: WorkOSUserSummary, inDetails = false) {
    return (
      <div className={styles.rowActions}>
        {!inDetails && (
          <button
            type="button"
            disabled={busy || sessionExpired}
            onClick={() => openDialog(user, "details")}
            aria-label={`View ${user.email}`}
          >
            Details
          </button>
        )}
        <button
          type="button"
          disabled={actionsDisabled}
          onClick={() => openDialog(user, "set")}
          aria-label={`${user.subscription ? "Edit subscription" : "Grant subscription"} for ${user.email}`}
        >
          {user.subscription ? "Edit" : "Grant access"}
        </button>
        {user.subscription && (
          <>
            <button
              type="button"
              disabled={actionsDisabled}
              onClick={() => openDialog(user, "extend")}
              aria-label={`Extend subscription for ${user.email}`}
            >
              Extend
            </button>
            <button
              type="button"
              disabled={actionsDisabled}
              onClick={() =>
                openDialog(
                  user,
                  user.subscription?.status === "revoked" ? "restore" : "revoke"
                )
              }
              aria-label={`${user.subscription.status === "revoked" ? "Restore" : "Revoke"} access for ${user.email}`}
            >
              {user.subscription.status === "revoked" ? "Restore" : "Revoke"}
            </button>
            {inDetails && (
              <>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={() => openDialog(user, "update-notes")}
                >
                  Edit notes
                </button>
                <button
                  type="button"
                  disabled={actionsDisabled || !user.subscription.device}
                  onClick={() => openDialog(user, "reset-device")}
                >
                  Reset Mac
                </button>
              </>
            )}
          </>
        )}
      </div>
    )
  }
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          photodepot
        </Link>
        <div className={styles.accountActions}>
          <span
            className={
              environment === "development"
                ? styles.development
                : styles.environment
            }
          >
            {environment === "development"
              ? "Development"
              : environment === "production"
                ? "Production"
                : "Checking environment…"}
          </span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className={styles.quiet} disabled={busy}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Administration · manual access</p>
          <h1>Subscriptions</h1>
          <p>
            Manage trials, subscription expiry, and access to one Mac per
            account.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true)
            void loadUsers()
          }}
          disabled={loading || busy}
        >
          {loading && hasLoaded ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {environment === "development" && (
        <p className={styles.environmentNotice}>
          Development environment. Changes apply only to the local development
          database and app builds connected to this environment.
        </p>
      )}
      <p className={styles.policy}>
        New signups receive a 7-day free trial. Admins manage access manually.
        No payment is collected.
      </p>
      {error && (
        <ErrorMessage message={error} sessionExpired={sessionExpired} />
      )}
      {reloadRequired && !dialog && (
        <p role="alert" className={styles.error}>
          Refresh subscription data before making another change.
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <section
        className={styles.overview}
        aria-labelledby="overview-title"
        aria-busy={loading}
      >
        <div className={styles.sectionHeading}>
          <h2 id="overview-title">Access overview</h2>
          <p>Across all recorded subscriptions in this environment.</p>
        </div>
        <dl className={styles.cards}>
          <div>
            <dt>Active access</dt>
            <dd>{overview?.active ?? "—"}</dd>
            <p>
              {overview
                ? `${overview.activeTrials} trial · ${overview.activeStandard} standard`
                : "Trial and standard subscriptions"}
            </p>
          </div>
          <div>
            <dt>Expiring in 7 days</dt>
            <dd>{overview?.expiringSoon ?? "—"}</dd>
            <p>Active subscriptions ending soon</p>
          </div>
          <div>
            <dt>Expired / revoked</dt>
            <dd>
              {overview ? `${overview.expired} / ${overview.revoked}` : "—"}
            </dd>
            <p>
              {overview
                ? `${overview.totalSubscriptions} subscriptions recorded`
                : "Accounts without current access"}
            </p>
          </div>
          <div>
            <dt>Assigned Macs</dt>
            <dd>{overview?.assignedMacs ?? "—"}</dd>
            <p>Current device assignments</p>
          </div>
        </dl>
      </section>
      <section
        className={styles.tableSection}
        aria-labelledby="users-title"
        aria-busy={loading}
      >
        <div className={styles.sectionHeading}>
          <h2 id="users-title">
            Accounts{" "}
            <span>
              {users.length}
              {cursor ? "+" : ""}
            </span>
          </h2>
          <p>Updates every 30 seconds while this page is visible.</p>
        </div>
        <div className={styles.filters}>
          <label className={styles.search}>
            Search loaded accounts
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, email, account ID, or notes"
            />
          </label>
          <label>
            Status
            <select
              aria-label="Status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {["Active", "Expired", "Revoked", "No subscription"].map(
                (value) => (
                  <option key={value}>{value}</option>
                )
              )}
            </select>
          </label>
          <label>
            Type
            <select
              aria-label="Type"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="all">All types</option>
              <option value="trial">Trial</option>
              <option value="regular">Standard</option>
            </select>
          </label>
          <label>
            Expiry
            <select
              aria-label="Expiry"
              value={expiryFilter}
              onChange={(event) => setExpiryFilter(event.target.value)}
            >
              <option value="all">Any expiry</option>
              <option value="7">Next 7 days</option>
              <option value="30">Next 30 days</option>
            </select>
          </label>
          <label>
            Sort
            <select
              aria-label="Sort"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="newest">Newest accounts</option>
              <option value="expiry">Earliest expiry</option>
              <option value="email">Email A–Z</option>
            </select>
          </label>
        </div>
        <div className={styles.listMeta}>
          <p role="status">
            {!hasLoaded ? (
              loading ? (
                "Loading account list…"
              ) : (
                "Account list is unavailable."
              )
            ) : (
              <>
                Showing {filteredUsers.length} of {users.length} loaded
                accounts.
                {cursor
                  ? " More accounts are available; search and filters apply only to loaded accounts."
                  : " All accounts are loaded."}
              </>
            )}
          </p>
          {filtersActive && (
            <button
              type="button"
              className={styles.quiet}
              onClick={clearFilters}
            >
              Clear filters
            </button>
          )}
        </div>
        {lastUpdated && (
          <p className={styles.updated}>
            Last updated <DateTime value={lastUpdated} />
            {error ? ". Showing the last available data." : "."}
          </p>
        )}
        <p className={styles.tableHint}>
          Scroll across the table to view expiry and actions.
        </p>
        <div
          className={styles.tableScroll}
          tabIndex={0}
          role="region"
          aria-label="Subscription accounts table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Access</th>
                <th scope="col">Expiry</th>
                <th scope="col">Mac</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{userName(user)}</strong>
                    {userName(user) !== user.email && (
                      <a href={`mailto:${user.email}`}>{user.email}</a>
                    )}
                    {!user.emailVerified && (
                      <span className={styles.unverified}>
                        Email not verified
                      </span>
                    )}
                    <small>
                      Joined <DateTime value={user.createdAt} />
                    </small>
                    {user.subscription?.notes && (
                      <p
                        className={styles.notePreview}
                        title={user.subscription.notes}
                      >
                        {user.subscription.notes}
                      </p>
                    )}
                  </td>
                  <td>
                    <StatusBadge value={status(user, now)} />
                    <small>
                      {user.subscription
                        ? subscriptionType(user.subscription.type)
                        : "No access granted"}
                    </small>
                  </td>
                  <td>
                    {user.subscription ? (
                      <>
                        <DateTime value={user.subscription.endsAt} />
                        <small>
                          {remaining(user.subscription.endsAt, now)}
                        </small>
                      </>
                    ) : (
                      <span className={styles.muted}>—</span>
                    )}
                  </td>
                  <td>
                    {user.subscription?.device ? (
                      <>
                        <span>Assigned</span>
                        <small>
                          Since{" "}
                          <DateTime
                            value={user.subscription.device.activatedAt}
                          />
                        </small>
                      </>
                    ) : (
                      <span className={styles.muted}>Unassigned</span>
                    )}
                  </td>
                  <td>{accountActions(user)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filteredUsers.length && (
          <div className={styles.empty}>
            {loading && !hasLoaded ? (
              "Loading accounts…"
            ) : !hasLoaded ? (
              "The account list is unavailable. Select Refresh to try again."
            ) : users.length ? (
              <>
                <p>No loaded accounts match these filters.</p>
                {cursor && <p>Load more accounts to search the next page.</p>}
              </>
            ) : (
              "No accounts yet. Users will appear here after signing up."
            )}
          </div>
        )}
        {cursor && (
          <button
            type="button"
            className={styles.more}
            onClick={() => {
              setLoading(true)
              void loadUsers(cursor)
            }}
            disabled={loading || busy || sessionExpired}
          >
            {loading ? "Loading…" : "Load more accounts"}
          </button>
        )}
      </section>
      <footer className={styles.footer}>
        One Mac per account. Dates use your browser’s time zone. Each
        subscription day adds 24 hours.
      </footer>
      {dialog && (
        <DashboardDialog
          key={`${dialog.user.id}-${dialog.action}`}
          onClose={closeDialog}
        >
          <div className={styles.dialogHeading}>
            <p className={styles.eyebrow}>
              {environment === "development" ? "Development" : "Production"} ·
              account access
            </p>
            <button
              type="button"
              className={styles.quiet}
              onClick={closeDialog}
              disabled={busy}
              data-dialog-focus
              aria-label="Close account dialog"
            >
              Close
            </button>
          </div>
          <h2 id="subscription-dialog-title">
            {dialog.action === "details"
              ? "Account details"
              : dialog.action === "set"
                ? dialog.user.subscription
                  ? "Edit subscription"
                  : "Grant subscription"
                : dialog.action === "extend"
                  ? "Extend subscription"
                  : dialog.action === "reset-device"
                    ? "Reset Mac assignment?"
                    : dialog.action === "update-notes"
                      ? "Edit account notes"
                      : `${dialog.action === "revoke" ? "Revoke" : "Restore"} access?`}
          </h2>
          <p className={styles.dialogAccount}>
            <strong>{userName(dialog.user)}</strong>
            {userName(dialog.user) !== dialog.user.email && (
              <>
                <br />
                {dialog.user.email}
              </>
            )}
          </p>
          {dialogError && (
            <ErrorMessage
              message={dialogError}
              sessionExpired={sessionExpired}
            />
          )}
          {reloadRequired && (
            <button
              type="button"
              onClick={refreshAfterConflict}
              disabled={busy}
            >
              Refresh account data
            </button>
          )}
          {dialog.action === "details" ? (
            <>
              <dl className={styles.accountDetails}>
                <div>
                  <dt>Account ID</dt>
                  <dd>{dialog.user.id}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>
                    {dialog.user.emailVerified ? "Verified" : "Not verified"}
                  </dd>
                </div>
                <div>
                  <dt>Joined</dt>
                  <dd>
                    <DateTime value={dialog.user.createdAt} />
                  </dd>
                </div>
              </dl>
              {detailsLoading ? (
                <p role="status">Loading subscription and history…</p>
              ) : dialogError ? (
                <button
                  type="button"
                  onClick={() => void loadDetails(dialog.user)}
                  disabled={sessionExpired}
                >
                  Retry details
                </button>
              ) : (
                details && (
                  <>
                    <div className={styles.detailSection}>
                      <h3>Current subscription</h3>
                      {dialog.user.subscription ? (
                        <>
                          <dl className={styles.accountDetails}>
                            <div>
                              <dt>Status</dt>
                              <dd>
                                <StatusBadge
                                  value={status(dialog.user, previewNow)}
                                />
                              </dd>
                            </div>
                            <div>
                              <dt>Type</dt>
                              <dd>
                                {subscriptionType(
                                  dialog.user.subscription.type
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>Started</dt>
                              <dd>
                                <DateTime
                                  value={dialog.user.subscription.startsAt}
                                />
                              </dd>
                            </div>
                            <div>
                              <dt>Expires</dt>
                              <dd>
                                <DateTime
                                  value={dialog.user.subscription.endsAt}
                                />
                              </dd>
                            </div>
                            <div>
                              <dt>Last changed</dt>
                              <dd>
                                <DateTime
                                  value={dialog.user.subscription.updatedAt}
                                />
                              </dd>
                            </div>
                            <div>
                              <dt>Revision</dt>
                              <dd>{dialog.user.subscription.revision}</dd>
                            </div>
                          </dl>
                          <h4>Admin notes</h4>
                          <p className={styles.notes}>
                            {dialog.user.subscription.notes ||
                              "No admin notes."}
                          </p>
                        </>
                      ) : (
                        <p>No subscription has been granted.</p>
                      )}
                      {accountActions(dialog.user, true)}
                    </div>
                    <div className={styles.detailSection}>
                      <h3>Mac assignments</h3>
                      <p>
                        One current Mac assignment is allowed. Resetting lets
                        the account sign in on another Mac.
                      </p>
                      {details.devices.length ? (
                        <ol className={styles.devices}>
                          {details.devices.map((device) => (
                            <li key={`${device.id}-${device.bindingRevision}`}>
                              <span
                                className={
                                  device.current
                                    ? styles.active
                                    : styles.noSubscription
                                }
                              >
                                {device.current
                                  ? "Current Mac"
                                  : "Previous Mac"}
                              </span>
                              <code>{device.id}</code>
                              <small>
                                Assigned <DateTime value={device.activatedAt} />
                              </small>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p>No Mac has been assigned.</p>
                      )}
                    </div>
                    <div className={styles.detailSection}>
                      <h3>Activity history</h3>
                      <p>
                        The latest 100 subscription and device changes, newest
                        first.
                      </p>
                      {details.audit.length ? (
                        <ol className={styles.history}>
                          {details.audit.map((entry) => (
                            <li key={entry.id}>
                              <strong>{entry.detail}</strong>
                              {entry.reason && (
                                <p className={styles.auditReason}>
                                  {entry.reason}
                                </p>
                              )}
                              <span>
                                <DateTime value={entry.createdAt} /> ·{" "}
                                {entry.actor}
                              </span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p>No subscription changes recorded.</p>
                      )}
                    </div>
                  </>
                )
              )}
            </>
          ) : (
            <form onSubmit={save}>
              {(dialog.action === "set" || dialog.action === "extend") && (
                <>
                  {dialog.user.subscription && (
                    <p>
                      Current expiry:{" "}
                      <DateTime value={dialog.user.subscription.endsAt} />.
                    </p>
                  )}
                  <div className={styles.formFields}>
                    {dialog.action === "set" && (
                      <label>
                        Subscription type
                        <select
                          value={selectedType}
                          onChange={(event) => {
                            const value = event.target.value as SubscriptionType
                            setSelectedType(value)
                            setDurationPreset(value === "trial" ? "7" : "30")
                          }}
                          disabled={busy}
                        >
                          <option value="trial">Trial</option>
                          <option value="regular">Standard</option>
                        </select>
                      </label>
                    )}
                    <label>
                      Choose expiry by
                      <select
                        value={expiryMode}
                        onChange={(event) => setExpiryMode(event.target.value)}
                        disabled={busy}
                      >
                        <option value="duration">
                          {dialog.action === "extend"
                            ? "Add days"
                            : "Duration from now"}
                        </option>
                        <option value="date">Exact date and time</option>
                      </select>
                    </label>
                    {expiryMode === "date" ? (
                      <label>
                        New expiry
                        <input
                          type="datetime-local"
                          value={customExpiry}
                          onChange={(event) =>
                            setCustomExpiry(event.target.value)
                          }
                          disabled={busy}
                          required
                          min={localDate(expiryBase + 60_000)}
                          max={localDate(previewNow + 3650 * day)}
                        />
                        <span className={styles.fieldHint}>
                          In your browser’s time zone.{" "}
                          {dialog.action === "extend"
                            ? "Must be later than the current expiry and now."
                            : "Must be later than now."}
                        </span>
                      </label>
                    ) : (
                      <>
                        <label>
                          {dialog.action === "extend"
                            ? "Add time"
                            : "Subscription length"}
                          <select
                            value={durationPreset}
                            onChange={(event) =>
                              setDurationPreset(event.target.value)
                            }
                            disabled={busy}
                          >
                            {durationPresets.map((days) => (
                              <option key={days} value={days}>
                                {days} days
                              </option>
                            ))}
                            <option value="custom">Custom duration</option>
                          </select>
                        </label>
                        {durationPreset === "custom" && (
                          <label>
                            Number of days
                            <input
                              type="number"
                              min={1}
                              max={3650}
                              step={1}
                              value={customDays}
                              onChange={(event) =>
                                setCustomDays(event.target.value)
                              }
                              disabled={busy}
                              required
                            />
                            <span className={styles.fieldHint}>
                              From 1 to 3,650 whole days.
                            </span>
                          </label>
                        )}
                      </>
                    )}
                  </div>
                  <div className={styles.preview}>
                    <span>New expiry</span>
                    {expiryPreview ? (
                      <time dateTime={new Date(expiryPreview).toISOString()}>
                        {fullDate(expiryPreview)}
                      </time>
                    ) : (
                      <p>Choose a valid expiry to see a preview.</p>
                    )}
                    <p>
                      {dialog.action === "extend"
                        ? `Adds time after ${dialog.user.subscription && dialog.user.subscription.endsAt > previewNow ? "the current expiry" : "now"}. Subscription type stays unchanged.`
                        : `Starts a ${subscriptionType(selectedType).toLowerCase()} subscription now. Existing Mac assignment stays in place.`}
                      {dialog.user.subscription?.status === "revoked" &&
                        (dialog.action === "extend"
                          ? " Access stays revoked; restore it separately."
                          : " This grant restores access.")}
                    </p>
                  </div>
                </>
              )}
              {dialog.action === "revoke" && (
                <p>
                  Revoke access for this account. The app will lose access when
                  it next checks its subscription. Its expiry and Mac assignment
                  stay recorded.
                </p>
              )}
              {dialog.action === "restore" && (
                <p>
                  Restore this account’s subscription without changing its
                  expiry.
                  {dialog.user.subscription &&
                  dialog.user.subscription.endsAt <= previewNow
                    ? " Its expiry has passed, so access will stay expired until you extend it."
                    : " Its existing Mac assignment stays in place."}
                </p>
              )}
              {dialog.action === "reset-device" && (
                <p>
                  Release the current Mac assignment{" "}
                  <code>{dialog.user.subscription?.device?.id}</code>. The
                  account can then sign in on another Mac. Its subscription
                  type, status, and expiry stay the same.
                </p>
              )}
              <div className={styles.formFields}>
                {(dialog.action === "set" ||
                  dialog.action === "update-notes") && (
                  <label>
                    Admin notes{" "}
                    <span className={styles.optional}>
                      Optional · visible to admins
                    </span>
                    <textarea
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      maxLength={2000}
                      rows={3}
                      disabled={busy}
                    />
                    <span className={styles.fieldHint}>
                      {notes.length}/2,000 characters
                    </span>
                  </label>
                )}
                <label>
                  Reason for this change{" "}
                  <span className={styles.optional}>
                    Optional · recorded in activity history
                  </span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={1000}
                    rows={2}
                    disabled={busy}
                  />
                </label>
              </div>
              <div className={styles.actions}>
                <button
                  type="submit"
                  disabled={
                    actionsDisabled ||
                    ((dialog.action === "set" || dialog.action === "extend") &&
                      !expiryPreview)
                  }
                  className={
                    dialog.action === "revoke" ? styles.danger : undefined
                  }
                >
                  {busy
                    ? "Saving…"
                    : dialog.action === "revoke"
                      ? "Revoke access"
                      : dialog.action === "restore"
                        ? "Restore subscription"
                        : dialog.action === "reset-device"
                          ? "Reset Mac assignment"
                          : dialog.action === "update-notes"
                            ? "Save notes"
                            : dialog.action === "extend"
                              ? "Extend subscription"
                              : "Save subscription"}
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={closeDialog}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </DashboardDialog>
      )}
    </main>
  )
}
