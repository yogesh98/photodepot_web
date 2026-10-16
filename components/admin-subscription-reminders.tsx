"use client"

import { Button } from "@/components/ui/button"

import { useCallback, useEffect, useRef, useState } from "react"
import type {
  SubscriptionSummary,
  WorkOSUserSummary,
} from "@/lib/subscription-types"
import styles from "./subscription-dashboard.module.css"

type ReminderQueue = {
  mode: "resend" | "disabled"
  upcoming: {
    subscription: SubscriptionSummary
    user: Omit<WorkOSUserSummary, "subscription" | "access" | "devices"> | null
  }[]
  outbox: {
    id: string
    userId: string
    endsAt: number
    status:
      | "pending"
      | "sending"
      | "preview"
      | "sent"
      | "failed"
      | "cancelled"
      | "uncertain"
    attempts: number
    updatedAt: number
    subject?: string
    recipient?: string
    text?: string
    error?: string
  }[]
  asOf: number
  remindWithinDays: number
  queueWithinDays: number
}
export function AdminSubscriptionReminders({
  disabled,
  onReview,
  refreshVersion = 0,
}: {
  disabled: boolean
  refreshVersion?: number
  onReview: (userId: string) => void
}) {
  const [queue, setQueue] = useState<ReminderQueue | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const load = useCallback(async (run = false) => {
    controller.current?.abort()
    const active = new AbortController()
    controller.current = active
    if (run) setRunning(true)
    else setLoading(true)
    try {
      const response = await fetch("/api/admin/subscription-reminders", {
        method: run ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: active.signal,
        ...(run
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "run" }),
            }
          : {}),
      })
      if (response.status === 401) {
        if (mounted.current && !active.signal.aborted) setSessionExpired(true)
        throw new Error(
          "Your session expired. Sign in in a new tab, then refresh this queue."
        )
      }
      const result = await response.json()
      if (!response.ok)
        throw new Error(
          typeof result?.error === "string"
            ? result.error
            : "Unable to load the renewal queue."
        )
      if (!Array.isArray(result.upcoming) || !Array.isArray(result.outbox))
        throw new Error("Unable to read the renewal queue.")
      if (mounted.current && !active.signal.aborted) {
        setQueue(result)
        setError("")
        setSessionExpired(false)
      }
    } catch (cause) {
      if (mounted.current && !active.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Unable to check reminders."
        )
    } finally {
      if (mounted.current && !active.signal.aborted) {
        setRunning(false)
        setLoading(false)
      }
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => {
      if (mounted.current) void load()
    })
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [load, refreshVersion])
  const date = (value: number) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value)
  return (
    <section
      className={styles.queue}
      aria-labelledby="daily-queue-title"
      aria-busy={loading || running}
    >
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="daily-queue-title">Daily renewal queue</h2>
          <p>
            Expiring within {queue?.queueWithinDays ?? 7} days · trial reminders{" "}
            {queue?.remindWithinDays ?? 2} days before expiry
          </p>
        </div>
        <div className={styles.rowActions}>
          <Button
            variant="outline"
            type="button"
            className={styles.quiet}
            disabled={loading || running}
            onClick={() => void load()}
          >
            Refresh renewal queue
          </Button>
          <Button
            variant="outline"
            type="button"
            disabled={
              disabled ||
              loading ||
              running ||
              queue?.mode === "disabled" ||
              !queue ||
              sessionExpired
            }
            onClick={() => void load(true)}
          >
            {running ? "Checking…" : "Check reminders now"}
          </Button>
        </div>
      </div>
      <p className={styles.updated}>
        {queue?.mode === "resend"
          ? "Reminder delivery is configured."
          : "Email delivery is disabled."}
      </p>
      {queue && (
        <p className={styles.updated}>
          Updated {date(queue.asOf)} · latest 100 records
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
          {sessionExpired && (
            <>
              {" "}
              <a
                href="/api/auth/login"
                target="_blank"
                rel="noopener noreferrer"
              >
                Sign in
              </a>
            </>
          )}
        </p>
      )}
      {!queue?.upcoming.length ? (
        <p className={styles.queueEmpty}>
          {loading
            ? "Loading upcoming renewals…"
            : !queue
              ? "The queue could not be loaded."
              : "No active subscriptions expire within this window."}
        </p>
      ) : (
        <ul className={styles.queueList}>
          {queue.upcoming.map(({ subscription, user }) => (
            <li key={subscription.id}>
              <div className={styles.queueItemHeading}>
                <div>
                  <strong>
                    {[user?.firstName, user?.lastName]
                      .filter(Boolean)
                      .join(" ") ||
                      user?.email ||
                      subscription.userId}
                  </strong>
                  <small>
                    {user?.email} ·{" "}
                    {subscription.type === "trial" ? "Trial" : "Standard"} ·
                    expires {date(subscription.endsAt)}
                  </small>
                </div>
                {user && (
                  <Button
                    variant="outline"
                    type="button"
                    className={styles.quiet}
                    disabled={disabled}
                    onClick={() => onReview(user.id)}
                  >
                    Review access
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!!queue?.outbox.length && (
        <details className={styles.reminderHistory}>
          <summary>Reminder history ({queue.outbox.length})</summary>
          <ul className={styles.queueList}>
            {queue.outbox.map((item) => (
              <li key={item.id}>
                <div className={styles.queueItemHeading}>
                  <strong>{item.recipient || item.userId}</strong>
                  <span
                    className={
                      item.status === "failed" || item.status === "uncertain"
                        ? styles.revoked
                        : styles.noSubscription
                    }
                  >
                    {item.status}
                  </span>
                </div>
                <small>
                  {date(item.updatedAt)} · {item.attempts} attempt
                  {item.attempts === 1 ? "" : "s"}
                </small>
                {item.subject && <p>{item.subject}</p>}
                {item.error && (
                  <p className={styles.queueContext}>{item.error}</p>
                )}
                {item.text && (
                  <pre className={styles.reminderMessage}>{item.text}</pre>
                )}
                {item.status === "uncertain" && (
                  <p className={styles.queueContext}>
                    Delivery could not be confirmed. Review this attempt before
                    retrying.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
