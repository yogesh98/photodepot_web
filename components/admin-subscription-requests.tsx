"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import type {
  AccountRequestAudit,
  AdminRequestQueue,
} from "@/lib/account-requests"
import type { WorkOSUserSummary } from "@/lib/subscription-types"
import styles from "./subscription-dashboard.module.css"

type QueueItem = AdminRequestQueue["requests"][number]
class RequestQueueError extends Error {
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
  const response = await fetch(`/api/admin/subscription-requests${query}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 401)
    throw new RequestQueueError(
      "Your admin session expired. Sign in again, then refresh the queue.",
      401
    )
  let result
  try {
    result = await response.json()
  } catch {
    throw new RequestQueueError(
      "Unable to read the request queue. Try again.",
      response.status
    )
  }
  if (!response.ok)
    throw new RequestQueueError(
      typeof result?.error === "string"
        ? result.error
        : "Unable to load the request queue.",
      response.status
    )
  return result as T
}
function date(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value)
}
export function AdminSubscriptionRequests({
  disabled,
  onReview,
}: {
  disabled: boolean
  onReview: (user: WorkOSUserSummary) => void
}) {
  const [queue, setQueue] = useState<AdminRequestQueue | null>(null)
  const [includeClosed, setIncludeClosed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [reloadRequired, setReloadRequired] = useState(false)
  const [notice, setNotice] = useState("")
  const [selected, setSelected] = useState<QueueItem | null>(null)
  const [action, setAction] = useState("acknowledge")
  const [note, setNote] = useState("")
  const [audit, setAudit] = useState<AccountRequestAudit[]>([])
  const request = useRef<AbortController | null>(null)
  const historyRequest = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const selectedId = useRef<string | null>(null)
  const load = useCallback(async () => {
    request.current?.abort()
    historyRequest.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const result = await api<AdminRequestQueue>(
        includeClosed ? "?includeClosed=1" : "",
        undefined,
        controller.signal
      )
      if (!Array.isArray(result.requests))
        throw new Error("Unable to read the request queue.")
      if (!controller.signal.aborted && mounted.current) {
        setQueue(result)
        setError("")
        setSessionExpired(false)
        setReloadRequired(false)
        setSelected(null)
        selectedId.current = null
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load the request queue."
        )
        if (cause instanceof RequestQueueError && cause.status === 401)
          setSessionExpired(true)
      }
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false)
    }
  }, [includeClosed])
  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => {
      if (mounted.current) void load()
    })
    return () => {
      mounted.current = false
      request.current?.abort()
      historyRequest.current?.abort()
    }
  }, [load])
  useEffect(() => {
    if (selected || busy || sessionExpired) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [load, selected, busy, sessionExpired])
  async function review(item: QueueItem) {
    request.current?.abort()
    historyRequest.current?.abort()
    const controller = new AbortController()
    historyRequest.current = controller
    setLoading(false)
    selectedId.current = item.id
    setSelected(item)
    setNote(item.adminNote)
    setAction(item.status === "pending" ? "acknowledge" : "resolve")
    setAudit([])
    setError("")
    setNotice("")
    try {
      const result = await api<{ audit: AccountRequestAudit[] }>(
        `?requestId=${encodeURIComponent(item.id)}`,
        undefined,
        controller.signal
      )
      if (
        mounted.current &&
        !controller.signal.aborted &&
        selectedId.current === item.id
      )
        setAudit(result.audit)
    } catch (cause) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        selectedId.current === item.id
      ) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to read request history."
        )
        if (cause instanceof RequestQueueError && cause.status === 401)
          setSessionExpired(true)
      }
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || busy || disabled || sessionExpired || reloadRequired)
      return
    setBusy(true)
    setError("")
    try {
      await api("", {
        action,
        requestId: selected.id,
        expectedRevision: selected.revision,
        note,
      })
      setNotice(
        "Request review saved. Subscription access changes are managed separately."
      )
      await load()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to review the request."
      )
      if (cause instanceof RequestQueueError && cause.status === 401)
        setSessionExpired(true)
      if (cause instanceof RequestQueueError && cause.status === 409)
        setReloadRequired(true)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  function openAccount(item: QueueItem) {
    if (!item.user) return
    onReview({
      ...item.user,
      subscription: item.subscription,
    })
  }
  return (
    <section
      className={styles.queue}
      aria-labelledby="requests-queue-title"
      aria-busy={loading}
    >
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="requests-queue-title">
            Customer requests <span>{queue?.openCount ?? "—"} open</span>
          </h2>
          <p>
            Review renewal and Mac removal requests. Apply grants or device
            resets from account details before marking a request completed.
          </p>
        </div>
        <button
          type="button"
          className={styles.quiet}
          disabled={loading || busy}
          onClick={() => void load()}
        >
          Refresh requests
        </button>
      </div>
      <label className={styles.queueFilter}>
        <input
          type="checkbox"
          checked={includeClosed}
          onChange={(event) => setIncludeClosed(event.target.checked)}
          disabled={busy}
        />
        Include completed and declined requests
      </label>
      {error && (
        <p role="alert" className={styles.error}>
          {error}{" "}
          <a href="/api/auth/login" target="_blank" rel="noopener noreferrer">
            Admin sign-in
          </a>
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {queue && (
        <p className={styles.updated}>
          Showing up to {queue.limit}{" "}
          {includeClosed ? "oldest recorded" : "oldest open"} requests.{" "}
          {queue.openCount} open across all accounts.
        </p>
      )}
      {!queue?.requests.length ? (
        <p className={styles.queueEmpty}>
          {loading
            ? "Loading customer requests…"
            : "No customer requests in this view."}
        </p>
      ) : (
        <ul className={styles.queueList}>
          {queue.requests.map((item) => (
            <li key={item.id}>
              <div className={styles.queueItemHeading}>
                <div>
                  <strong>
                    {item.action === "renewal" ? "Renewal" : "Mac removal"} ·{" "}
                    {item.email}
                  </strong>
                  <small>
                    {item.userId} · Submitted {date(item.createdAt)}
                  </small>
                </div>
                <span
                  className={
                    item.status === "pending" || item.status === "acknowledged"
                      ? styles.expired
                      : styles.noSubscription
                  }
                >
                  {item.status === "acknowledged"
                    ? "Under review"
                    : item.status}
                </span>
              </div>
              <p className={styles.queueContext}>
                {item.subscription
                  ? `${item.subscription.type === "trial" ? "Trial" : "Standard"} · ${item.subscription.status} · expires ${date(item.subscription.endsAt)} · ${item.subscription.devices.length}/${item.subscription.deviceLimit} Macs`
                  : "No subscription assigned"}
              </p>
              {!item.user && (
                <p className={styles.queueContext}>
                  This account is no longer available. Its request can still be
                  reviewed.
                </p>
              )}
              {item.deviceId && (
                <code className={styles.queueDevice}>{item.deviceId}</code>
              )}
              {item.message && (
                <p className={styles.queueMessage}>{item.message}</p>
              )}
              {item.adminNote && (
                <p className={styles.queueAdminNote}>
                  Admin note: {item.adminNote}
                </p>
              )}
              <div className={styles.rowActions}>
                <button
                  type="button"
                  onClick={() => openAccount(item)}
                  disabled={disabled || busy || sessionExpired || !item.user}
                >
                  Open account
                </button>
                <button
                  type="button"
                  onClick={() => void review(item)}
                  disabled={
                    disabled || busy || sessionExpired || reloadRequired
                  }
                >
                  {["pending", "acknowledged"].includes(item.status)
                    ? "Review request"
                    : "View review"}
                </button>
              </div>
              {selected?.id === item.id && (
                <form className={styles.queueReview} onSubmit={save}>
                  <h3>
                    Review{" "}
                    {item.action === "renewal" ? "renewal" : "Mac removal"}{" "}
                    request
                  </h3>
                  {["pending", "acknowledged"].includes(item.status) && (
                    <>
                      <label>
                        Review outcome
                        <select
                          aria-label="Review outcome"
                          value={action}
                          onChange={(event) => setAction(event.target.value)}
                          disabled={busy}
                        >
                          {item.status === "pending" && (
                            <option value="acknowledge">
                              Acknowledge — under review
                            </option>
                          )}
                          <option value="resolve">
                            Complete — work finished
                          </option>
                          <option value="reject">Decline</option>
                        </select>
                      </label>
                      <label>
                        Admin review note
                        <span className={styles.fieldHint}>
                          Optional · admins only · 1,000 characters maximum
                        </span>
                        <textarea
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          maxLength={1000}
                          rows={3}
                          disabled={busy}
                        />
                      </label>
                      <p>
                        Saving this review updates only the request’s status. It
                        does not grant access or remove a Mac.
                      </p>
                    </>
                  )}
                  {audit.length > 0 && (
                    <ol className={styles.history}>
                      {audit.map((entry) => (
                        <li key={entry.id}>
                          <strong>{entry.action}</strong>
                          {entry.note && (
                            <p className={styles.auditReason}>{entry.note}</p>
                          )}
                          <span>
                            {date(entry.createdAt)} · {entry.actor}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  <div className={styles.actions}>
                    {["pending", "acknowledged"].includes(item.status) && (
                      <button
                        type="submit"
                        disabled={
                          busy || disabled || sessionExpired || reloadRequired
                        }
                      >
                        {busy ? "Saving…" : "Save review"}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.quiet}
                      onClick={() => {
                        historyRequest.current?.abort()
                        selectedId.current = null
                        setSelected(null)
                      }}
                      disabled={busy}
                    >
                      Close review
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
