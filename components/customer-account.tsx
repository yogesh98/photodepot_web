"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import type { CustomerAccount, CustomerRequest } from "@/lib/account-requests"
import styles from "./customer-account.module.css"

type RequestForm = {
  action: "request-renewal" | "request-device-reset"
  deviceId?: string
}
class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}
async function api<T>(body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/account/subscription", {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 401)
    throw new AccountError(
      "Your session expired. Sign in again, then refresh your account.",
      401
    )
  let result
  try {
    result = await response.json()
  } catch {
    throw new AccountError(
      "Unable to read your account. Please try again.",
      response.status
    )
  }
  if (!response.ok)
    throw new AccountError(
      typeof result?.error === "string"
        ? result.error
        : "Your account is temporarily unavailable.",
      response.status
    )
  return result as T
}
function date(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(value)
}
function DateTime({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{date(value)}</time>
}
function requestStatus(request: CustomerRequest) {
  return request.status === "pending"
    ? "Awaiting review"
    : request.status === "acknowledged"
      ? "Under review"
      : request.status === "resolved"
        ? "Completed"
        : "Declined"
}
function RequestDialog({
  form,
  busy,
  sessionExpired,
  error,
  message,
  onMessage,
  onClose,
  onSubmit,
}: {
  form: RequestForm
  busy: boolean
  sessionExpired: boolean
  error: string
  message: string
  onMessage: (value: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    cancel.current?.focus()
    return () => {
      element?.close()
      previous?.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="request-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return
        const elements = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), textarea:not(:disabled), a[href]"
          )
        ).filter((element) => element.getClientRects().length > 0)
        const first = elements[0],
          last = elements.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
    >
      <form className={styles.modal} onSubmit={onSubmit}>
        <h2 id="request-title">
          {form.action === "request-renewal"
            ? "Request renewal"
            : "Request Mac removal"}
        </h2>
        <p>
          {form.action === "request-renewal"
            ? "An administrator will review your renewal request. This does not charge you or immediately change your subscription."
            : "An administrator will review this Mac removal. The Mac stays connected until the request is approved and its assignment is removed."}
        </p>
        {form.deviceId && (
          <code className={styles.deviceId}>{form.deviceId}</code>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
            {sessionExpired && (
              <>
                {" "}
                <a
                  href="/api/account/auth/login"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Sign in
                </a>
              </>
            )}
          </p>
        )}
        <label>
          Message to the administrator{" "}
          <span>Optional · up to 1,000 characters</span>
          <textarea
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            maxLength={1000}
            rows={4}
            disabled={busy}
          />
        </label>
        <div className={styles.actions}>
          <button type="submit" disabled={busy || sessionExpired}>
            {busy ? "Submitting…" : "Submit request"}
          </button>
          <button
            ref={cancel}
            type="button"
            className={styles.quiet}
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function CustomerAccountPage() {
  const [account, setAccount] = useState<CustomerAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [notice, setNotice] = useState("")
  const [form, setForm] = useState<RequestForm | null>(null)
  const [message, setMessage] = useState("")
  const [formError, setFormError] = useState("")
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const load = useCallback(async () => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    try {
      const data = await api<CustomerAccount>(undefined, controller.signal)
      if (
        !data?.user?.email ||
        !Array.isArray(data.requests) ||
        !["development", "production"].includes(data.environment) ||
        (data.subscription && !Array.isArray(data.subscription.devices))
      )
        throw new Error("Unable to read your account. Please try again.")
      if (!mounted.current || controller.signal.aborted) return
      setAccount(data)
      setError("")
      setSessionExpired(false)
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load your account."
        )
        if (cause instanceof AccountError && cause.status === 401)
          setSessionExpired(true)
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        if (mounted.current) setLoading(false)
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
      request.current?.abort()
      request.current = null
    }
  }, [load])
  useEffect(() => {
    if (form || busy || sessionExpired) return
    const poll = () => {
      if (document.visibilityState === "visible") void load()
    }
    const timer = window.setInterval(poll, 30_000)
    document.addEventListener("visibilitychange", poll)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [load, form, busy, sessionExpired])
  function open(form: RequestForm) {
    request.current?.abort()
    request.current = null
    setLoading(false)
    setForm(form)
    setMessage("")
    setFormError("")
    setNotice("")
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form || busy || sessionExpired) return
    setBusy(true)
    setFormError("")
    try {
      const result = await api<{ created: boolean; request: CustomerRequest }>({
        ...form,
        message: message.trim(),
      })
      if (!mounted.current) return
      setNotice(
        result.created
          ? "Request submitted. An administrator will review it; your access is unchanged."
          : "You already have an open request for this change. It is awaiting an administrator’s review."
      )
      setForm(null)
      setLoading(true)
      await load()
    } catch (cause) {
      if (mounted.current) {
        setFormError(
          cause instanceof Error
            ? cause.message
            : "Unable to submit your request."
        )
        if (cause instanceof AccountError && cause.status === 401) {
          setSessionExpired(true)
          setError(
            "Sign in again, then refresh your account before submitting a request."
          )
        }
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const subscription = account?.subscription
  const openRequests =
    account?.requests.filter((request) =>
      ["pending", "acknowledged"].includes(request.status)
    ) ?? []
  const renewalPending = openRequests.some(
    (request) => request.action === "renewal"
  )
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          photodepot
        </Link>
        <div className={styles.headerActions}>
          {account?.environment === "development" && (
            <span className={styles.environment}>Development</span>
          )}
          <form action="/api/account/auth/logout" method="post">
            <button type="submit" className={styles.quiet} disabled={busy}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Your Photodepot account</p>
          <h1>Plan &amp; connected Macs</h1>
          {account && <p>{account.user.email}</p>}
        </div>
        <button
          type="button"
          className={styles.quiet}
          disabled={loading || busy}
          onClick={() => {
            setLoading(true)
            void load()
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {account?.environment === "development" && (
        <p className={styles.environmentNotice}>
          You’re viewing the development environment. Requests and subscriptions
          here affect development builds only.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
          {sessionExpired && (
            <>
              {" "}
              <a
                href="/api/account/auth/login"
                target="_blank"
                rel="noopener noreferrer"
              >
                Sign in
              </a>
            </>
          )}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {!account ? (
        <p role="status" className={styles.empty}>
          {loading
            ? "Loading your account…"
            : "Select Refresh to try loading your account again."}
        </p>
      ) : (
        <>
          <div className={styles.columns}>
            <section className={styles.card} aria-labelledby="plan-title">
              <div className={styles.cardHeading}>
                <h2 id="plan-title">Your plan</h2>
                <span
                  className={
                    subscription?.status === "active"
                      ? styles.active
                      : styles.inactive
                  }
                >
                  {subscription?.status === "active"
                    ? "Active"
                    : subscription?.status === "revoked"
                      ? "Access revoked"
                      : subscription
                        ? "Expired"
                        : "No subscription"}
                </span>
              </div>
              <p className={styles.plan}>
                {subscription
                  ? subscription.type === "trial"
                    ? "Free trial"
                    : "Standard subscription"
                  : "No plan assigned"}
              </p>
              {subscription && (
                <dl>
                  <div>
                    <dt>Started</dt>
                    <dd>
                      <DateTime value={subscription.startsAt} />
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {subscription.status === "expired"
                        ? "Expired"
                        : "Expires"}
                    </dt>
                    <dd>
                      <DateTime value={subscription.endsAt} />
                    </dd>
                  </div>
                </dl>
              )}
              <p>
                Access is managed by the Photodepot administrator. No payment is
                collected through this account page.
              </p>
              <button
                type="button"
                onClick={() => open({ action: "request-renewal" })}
                disabled={busy || sessionExpired || renewalPending}
              >
                {renewalPending ? "Renewal requested" : "Request renewal"}
              </button>
            </section>
            <section className={styles.card} aria-labelledby="macs-title">
              <div className={styles.cardHeading}>
                <h2 id="macs-title">Connected Macs</h2>
                <span className={styles.count}>
                  {subscription?.devices.length ?? 0} /{" "}
                  {subscription?.deviceLimit ?? 2}
                </span>
              </div>
              <p>
                Use your subscription on up to two Macs. Sign in from the
                Photodepot app to connect a Mac.
              </p>
              {subscription?.devices.length ? (
                <ol className={styles.devices}>
                  {subscription.devices.map((device, index) => {
                    const pending = openRequests.some(
                      (request) =>
                        request.action === "reset-device" &&
                        request.deviceId === device.id
                    )
                    return (
                      <li key={device.id}>
                        <strong>Mac {index + 1}</strong>
                        <span>
                          Connected <DateTime value={device.activatedAt} />
                        </span>
                        <details>
                          <summary>Mac identifier</summary>
                          <code className={styles.deviceId}>{device.id}</code>
                        </details>
                        <button
                          type="button"
                          className={styles.quiet}
                          onClick={() =>
                            open({
                              action: "request-device-reset",
                              deviceId: device.id,
                            })
                          }
                          disabled={busy || sessionExpired || pending}
                          aria-label={`${pending ? "Removal requested" : "Request removal"} for Mac ${index + 1}`}
                        >
                          {pending ? "Removal requested" : "Request removal"}
                        </button>
                      </li>
                    )
                  })}
                </ol>
              ) : (
                <p className={styles.empty}>No Macs connected yet.</p>
              )}
            </section>
          </div>
          <section className={styles.requests} aria-labelledby="requests-title">
            <h2 id="requests-title">Your requests</h2>
            <p>
              An administrator reviews requests before changing access. This
              shows your latest 50 requests.
            </p>
            {account.requests.length ? (
              <ol>
                {account.requests.map((request) => (
                  <li key={request.id}>
                    <div>
                      <strong>
                        {request.action === "renewal"
                          ? "Subscription renewal"
                          : "Mac removal"}
                      </strong>
                      <span className={styles.requestStatus}>
                        {requestStatus(request)}
                      </span>
                    </div>
                    {request.deviceId && (
                      <code className={styles.deviceId}>
                        {request.deviceId}
                      </code>
                    )}
                    {request.message && (
                      <p className={styles.message}>{request.message}</p>
                    )}
                    <small>
                      Submitted <DateTime value={request.createdAt} />
                      {request.updatedAt !== request.createdAt && (
                        <>
                          {" "}
                          · Updated <DateTime value={request.updatedAt} />
                        </>
                      )}
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.empty}>No requests yet.</p>
            )}
          </section>
        </>
      )}
      <footer className={styles.footer}>
        Dates are shown in your browser’s time zone. New accounts receive a
        7-day free trial.
      </footer>
      {form && (
        <RequestDialog
          form={form}
          busy={busy}
          sessionExpired={sessionExpired}
          error={formError}
          message={message}
          onMessage={setMessage}
          onClose={() => {
            if (!busy) setForm(null)
          }}
          onSubmit={submit}
        />
      )}
    </main>
  )
}
