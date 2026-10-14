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
  SubscriptionType,
  WorkOSUserSummary,
} from "@/lib/subscription-types"
import styles from "./subscription-dashboard.module.css"

const day = 24 * 60 * 60 * 1000
const durationPresets = [7, 14, 30, 90, 365]
type DialogAction =
  "set" | "extend" | "revoke" | "restore" | "reset-device" | "history"
type PendingDialog = { user: WorkOSUserSummary; action: DialogAction }
type UserPage = { users: WorkOSUserSummary[]; nextCursor: string | null }
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
      "This subscription changed while you were editing. Close this dialog, select Refresh, and try again.",
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
function userName(user: WorkOSUserSummary) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
}
function subscriptionType(type: SubscriptionType) {
  return type === "trial" ? "Trial" : "Standard"
}
function status(user: WorkOSUserSummary, now: number) {
  const subscription = user.subscription
  if (!subscription) return "No subscription"
  if (subscription.status === "revoked") return "Revoked"
  return subscription.endsAt <= now || subscription.status === "expired"
    ? "Expired"
    : "Active"
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
  titleId,
}: {
  children: ReactNode
  onClose: () => void
  titleId: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    element?.querySelector<HTMLElement>("[data-dialog-focus]")?.focus()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.overlay}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
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
    !(result.nextCursor === null || typeof result.nextCursor === "string")
  )
    throw new Error("Unable to read the user list. Try again.")
  return result
}

export function SubscriptionDashboard() {
  const [users, setUsers] = useState<WorkOSUserSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [reloadRequired, setReloadRequired] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [dialog, setDialog] = useState<PendingDialog | null>(null)
  const [dialogError, setDialogError] = useState("")
  const [selectedType, setSelectedType] = useState<SubscriptionType>("trial")
  const [durationPreset, setDurationPreset] = useState("14")
  const [customDays, setCustomDays] = useState("14")
  const [previewNow, setPreviewNow] = useState(0)
  const [audit, setAudit] = useState<SubscriptionAudit[]>([])
  const [auditLoading, setAuditLoading] = useState(false)
  const mounted = useRef(false)
  const listRequest = useRef<AbortController | null>(null)
  const auditRequest = useRef<AbortController | null>(null)
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
        if (!next) {
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
        }
        if (!mounted.current || listRequest.current !== controller) return
        setUsers((previous) => mergeUsers(next ? previous : [], incoming))
        setCursor(nextCursor)
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
      auditRequest.current?.abort()
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
    const interval = window.setInterval(poll, 30000)
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

  function openDialog(user: WorkOSUserSummary, action: DialogAction) {
    listRequest.current?.abort()
    listRequest.current = null
    setLoading(false)
    setDialog({ user, action })
    setDialogError("")
    setNotice("")
    setPreviewNow(Date.now())
    setSelectedType(user.subscription?.type ?? "trial")
    const days = user.subscription?.type === "regular" ? "30" : "14"
    setDurationPreset(days)
    setCustomDays(days)
    if (action === "history") void loadHistory(user)
  }
  function closeDialog() {
    if (busy) return
    auditRequest.current?.abort()
    auditRequest.current = null
    setDialog(null)
    setDialogError("")
  }
  async function loadHistory(user: WorkOSUserSummary) {
    auditRequest.current?.abort()
    const controller = new AbortController()
    auditRequest.current = controller
    setAudit([])
    setAuditLoading(true)
    setDialogError("")
    try {
      const result = await api<{ audit: SubscriptionAudit[] }>(
        `?userId=${encodeURIComponent(user.id)}&history=1`,
        undefined,
        controller.signal
      )
      if (!Array.isArray(result?.audit))
        throw new Error("Unable to read subscription history. Try again.")
      if (!controller.signal.aborted && mounted.current) setAudit(result.audit)
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        handleError(cause, true)
    } finally {
      if (auditRequest.current === controller) {
        auditRequest.current = null
        if (mounted.current) setAuditLoading(false)
      }
    }
  }
  const durationDays = Number(
    durationPreset === "custom" ? customDays : durationPreset
  )
  const validDuration =
    Number.isInteger(durationDays) && durationDays >= 1 && durationDays <= 3650
  const expiryPreview =
    dialog && validDuration
      ? (dialog.action === "extend"
          ? Math.max(previewNow, dialog.user.subscription?.endsAt ?? previewNow)
          : previewNow) +
        durationDays * day
      : null
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !dialog ||
      busy ||
      sessionExpired ||
      reloadRequired ||
      dialog.action === "history"
    )
      return
    const timed = dialog.action === "set" || dialog.action === "extend"
    if (timed && !validDuration) {
      setDialogError("Enter a whole number of days from 1 to 3,650.")
      return
    }
    setBusy(true)
    setDialogError("")
    setError("")
    setNotice("")
    try {
      await api("", {
        action: dialog.action,
        userId: dialog.user.id,
        expectedRevision: dialog.user.subscription?.revision ?? 0,
        ...(timed ? { durationDays } : {}),
        ...(dialog.action === "set" ? { type: selectedType } : {}),
      })
      setNotice(
        dialog.action === "revoke"
          ? `Subscription revoked for ${dialog.user.email}.`
          : dialog.action === "reset-device"
            ? `Mac assignment reset for ${dialog.user.email}. The account can sign in on another Mac.`
            : dialog.action === "restore"
              ? `Subscription restored for ${dialog.user.email}. Its expiry has not changed.`
              : `Subscription ${dialog.action === "extend" ? "extended" : "saved"} for ${dialog.user.email}.`
      )
      setDialog(null)
      setLoading(true)
      await loadUsers()
    } catch (cause) {
      handleError(cause, true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const actionsDisabled = busy || sessionExpired || reloadRequired
  const now = lastUpdated ?? 0

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          photodepot
        </Link>
        <div className={styles.accountActions}>
          <span>Administration</span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className={styles.quiet} disabled={busy}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Account management</p>
          <h1>User subscriptions</h1>
          <p>
            Manage each account’s trial or standard subscription and expiry.
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
      {error && (
        <ErrorMessage message={error} sessionExpired={sessionExpired} />
      )}
      {reloadRequired && !dialog && (
        <p role="alert" className={styles.error}>
          Subscription data changed. Select Refresh before making another
          change.
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <section
        className={styles.tableSection}
        aria-labelledby="users-title"
        aria-busy={loading}
      >
        <div className={styles.tableHeading}>
          <h2 id="users-title">
            Accounts{" "}
            <span>
              {users.length}
              {cursor ? "+" : ""}
            </span>
          </h2>
          <p>
            New accounts appear automatically. The list updates every 30 seconds
            while this page is visible.
          </p>
        </div>
        {lastUpdated && (
          <p className={styles.updated}>
            Last updated {shortDate(lastUpdated)}
            {error ? ". Showing the last available user list." : "."}
          </p>
        )}
        <p className={styles.tableHint}>
          Scroll across the table to view expiry and actions.
        </p>
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Subscription</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const currentStatus = status(user, now)
                return (
                  <tr key={user.id}>
                    <td>
                      <strong>{userName(user)}</strong>
                      {[user.firstName, user.lastName].some(Boolean) && (
                        <a href={`mailto:${user.email}`}>{user.email}</a>
                      )}
                      {!user.emailVerified && (
                        <span className={styles.unverified}>
                          Email not verified
                        </span>
                      )}
                      <small>Joined {shortDate(user.createdAt)}</small>
                    </td>
                    <td>
                      {user.subscription ? (
                        <>
                          <span>
                            {subscriptionType(user.subscription.type)}
                          </span>
                          <small>
                            Started {shortDate(user.subscription.startsAt)}
                          </small>
                        </>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          currentStatus === "Active"
                            ? styles.active
                            : currentStatus === "Revoked"
                              ? styles.revoked
                              : currentStatus === "Expired"
                                ? styles.expired
                                : styles.noSubscription
                        }
                      >
                        {currentStatus}
                      </span>
                    </td>
                    <td>
                      {user.subscription ? (
                        <time
                          dateTime={new Date(
                            user.subscription.endsAt
                          ).toISOString()}
                          title={fullDate(user.subscription.endsAt)}
                        >
                          {shortDate(user.subscription.endsAt)}
                        </time>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          disabled={actionsDisabled}
                          onClick={() => openDialog(user, "set")}
                        >
                          {user.subscription ? "Edit" : "Set subscription"}
                        </button>
                        {user.subscription && (
                          <>
                            <button
                              type="button"
                              disabled={actionsDisabled}
                              onClick={() => openDialog(user, "extend")}
                            >
                              Extend
                            </button>
                            <button
                              type="button"
                              disabled={actionsDisabled}
                              onClick={() => openDialog(user, "reset-device")}
                            >
                              Reset Mac
                            </button>
                            <button
                              type="button"
                              disabled={actionsDisabled}
                              onClick={() =>
                                openDialog(
                                  user,
                                  user.subscription?.status === "revoked"
                                    ? "restore"
                                    : "revoke"
                                )
                              }
                            >
                              {user.subscription.status === "revoked"
                                ? "Restore"
                                : "Revoke"}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          disabled={busy || sessionExpired}
                          onClick={() => openDialog(user, "history")}
                        >
                          History
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {!users.length && (
          <p className={styles.empty}>
            {loading
              ? "Loading accounts…"
              : !hasLoaded
                ? "The user list is unavailable. Select Refresh to try again."
                : "No accounts yet. Users will appear here after signing up."}
          </p>
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
          titleId="subscription-dialog-title"
          onClose={closeDialog}
        >
          <h2 id="subscription-dialog-title">
            {dialog.action === "history"
              ? "Subscription history"
              : dialog.action === "set"
                ? `${dialog.user.subscription ? "Edit" : "Set"} subscription`
                : dialog.action === "extend"
                  ? "Extend subscription"
                  : dialog.action === "reset-device"
                    ? "Reset this Mac assignment?"
                    : `${dialog.action === "revoke" ? "Revoke" : "Restore"} subscription?`}
          </h2>
          <p className={styles.dialogAccount}>
            {userName(dialog.user)}
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
          {dialog.action === "history" ? (
            <>
              {auditLoading ? (
                <p role="status">Loading history…</p>
              ) : dialogError ? (
                <button
                  type="button"
                  onClick={() => void loadHistory(dialog.user)}
                  disabled={sessionExpired}
                >
                  Retry history
                </button>
              ) : audit.length ? (
                <ol className={styles.history}>
                  {audit.map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.detail}</strong>
                      <span>
                        {shortDate(entry.createdAt)} · {entry.actor}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No subscription changes recorded.</p>
              )}
              <div className={styles.actions}>
                <button type="button" onClick={closeDialog} data-dialog-focus>
                  Close history
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={save}>
              {dialog.action === "set" || dialog.action === "extend" ? (
                <>
                  {dialog.user.subscription && (
                    <p>
                      Current expiry:{" "}
                      <time
                        dateTime={new Date(
                          dialog.user.subscription.endsAt
                        ).toISOString()}
                      >
                        {fullDate(dialog.user.subscription.endsAt)}
                      </time>
                      .
                    </p>
                  )}
                  <div className={styles.formFields}>
                    {dialog.action === "set" && (
                      <label>
                        Subscription type
                        <select
                          value={selectedType}
                          onChange={(event) =>
                            setSelectedType(
                              event.target.value as SubscriptionType
                            )
                          }
                          disabled={busy}
                          data-dialog-focus
                        >
                          <option value="trial">Trial</option>
                          <option value="regular">Standard</option>
                        </select>
                      </label>
                    )}
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
                        data-dialog-focus={
                          dialog.action === "extend" || undefined
                        }
                      >
                        {durationPresets.map((days) => (
                          <option key={days} value={days}>
                            {days} days
                          </option>
                        ))}
                        <option value="custom">Custom length</option>
                      </select>
                    </label>
                    {durationPreset === "custom" && (
                      <label>
                        Number of days
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={3650}
                          step={1}
                          required
                          value={customDays}
                          onChange={(event) =>
                            setCustomDays(event.target.value)
                          }
                          disabled={busy}
                          aria-describedby="duration-help"
                        />
                        <span id="duration-help" className={styles.fieldHint}>
                          1 to 3,650 whole days.
                        </span>
                      </label>
                    )}
                  </div>
                  <div className={styles.preview}>
                    <span>Expiry preview</span>
                    {expiryPreview ? (
                      <time dateTime={new Date(expiryPreview).toISOString()}>
                        {fullDate(expiryPreview)}
                      </time>
                    ) : (
                      <p>Enter a whole number of days from 1 to 3,650.</p>
                    )}
                  </div>
                  <p>
                    {dialog.action === "set"
                      ? "Saving starts a new active subscription now and replaces the existing term."
                      : "Time is added to the current expiry, or starts now if the term has ended."}
                  </p>
                  {dialog.action === "extend" &&
                    dialog.user.subscription?.status === "revoked" && (
                      <p>
                        This subscription remains revoked after extending.
                        Restore it separately to allow access.
                      </p>
                    )}
                </>
              ) : (
                <>
                  <p>
                    {dialog.action === "revoke"
                      ? "This account’s subscription will be revoked. Its existing expiry is retained so you can restore it later."
                      : dialog.action === "reset-device"
                        ? "The account can sign in on another Mac. The previous Mac will need to sign in again for its next session. Its current work and collaboration continue until quit."
                        : "Restore this account’s subscription using its existing expiry."}
                  </p>
                  {dialog.action === "restore" &&
                    dialog.user.subscription &&
                    dialog.user.subscription.endsAt <= previewNow && (
                      <p>
                        The term has ended. Restoring leaves the subscription
                        expired. Extend the term or set a new subscription to
                        allow access.
                      </p>
                    )}
                </>
              )}
              <div className={styles.actions}>
                <button
                  type="submit"
                  disabled={
                    actionsDisabled ||
                    ((dialog.action === "set" || dialog.action === "extend") &&
                      !validDuration)
                  }
                >
                  {busy
                    ? "Saving…"
                    : dialog.action === "set"
                      ? "Save subscription"
                      : dialog.action === "extend"
                        ? "Extend subscription"
                        : dialog.action === "reset-device"
                          ? "Reset Mac"
                          : dialog.action === "revoke"
                            ? "Revoke subscription"
                            : "Restore subscription"}
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={closeDialog}
                  disabled={busy}
                  data-dialog-focus={
                    dialog.action === "revoke" ||
                    dialog.action === "restore" ||
                    dialog.action === "reset-device" ||
                    undefined
                  }
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
