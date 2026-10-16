"use client"

import { DashboardFrame } from "@/components/dashboard-frame"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  ArrowRight,
  CalendarDays,
  Check,
  Clock3,
  CreditCard,
  GalleryVerticalEnd,
  History,
  LayoutDashboard,
  Monitor,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import type { CustomerAccount, CustomerRequest } from "@/lib/account-requests"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import styles from "./customer-account.module.css"

type RequestForm = { action: "request-renewal" }
type SelectedMac = {
  id: string
  label: string
  revision: number
  sessionId: string
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
function date(value: number, short = false) {
  return new Intl.DateTimeFormat(
    undefined,
    short
      ? { month: "short", day: "numeric", year: "numeric" }
      : { dateStyle: "long", timeStyle: "short" }
  ).format(value)
}
function DateTime({
  value,
  short = false,
}: {
  value: number
  short?: boolean
}) {
  return (
    <time dateTime={new Date(value).toISOString()} title={date(value)}>
      {date(value, short)}
    </time>
  )
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
function SignInLink() {
  return (
    <a href="/api/account/auth/login" target="_blank" rel="noopener noreferrer">
      Sign in
    </a>
  )
}
function RequestDialog({
  title,
  busy,
  sessionExpired,
  error,
  message,
  onMessage,
  onClose,
  onSubmit,
}: {
  title: string
  busy: boolean
  sessionExpired: boolean
  error: string
  message: string
  onMessage: (value: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
      disablePointerDismissal={busy}
    >
      <DialogContent
        className={styles.modal}
        showCloseButton={false}
        initialFocus={cancel}
      >
        <form onSubmit={onSubmit}>
          <DialogHeader className={styles.modalHeading}>
            <div className={styles.modalIcon}>
              <CreditCard />
            </div>
            <DialogTitle className={styles.modalTitle}>{title}</DialogTitle>
            <DialogDescription className={styles.modalDescription}>
              Requires administrator approval. No payment or access change
              occurs when you submit.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
              {sessionExpired && (
                <>
                  {" "}
                  <SignInLink />
                </>
              )}
            </p>
          )}
          <div className={styles.field}>
            <Label htmlFor="request-message">
              Message to the administrator
            </Label>
            <Textarea
              id="request-message"
              value={message}
              onChange={(event) => onMessage(event.target.value)}
              maxLength={1000}
              rows={4}
              disabled={busy}
            />
            <span className={styles.fieldHint}>
              Optional · up to 1,000 characters
            </span>
          </div>
          <DialogFooter className={styles.modalActions}>
            <Button
              ref={cancel}
              type="button"
              variant="outline"
              className={styles.button}
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className={styles.button}
              disabled={busy || sessionExpired}
            >
              {busy ? "Submitting…" : "Submit request"}
              <ArrowRight />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const [selectedMac, setSelectedMac] = useState<SelectedMac | null>(null)
  const [removalConflict, setRemovalConflict] = useState(false)
  const [message, setMessage] = useState("")
  const [formError, setFormError] = useState("")
  const removalCancel = useRef<HTMLButtonElement>(null)
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
        !Array.isArray(data.devices) ||
        !data.access ||
        !data.reminders
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
    if (form || selectedMac || busy || sessionExpired) return
    const poll = () => {
      if (document.visibilityState === "visible") void load()
    }
    const timer = window.setInterval(poll, 30_000)
    document.addEventListener("visibilitychange", poll)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [load, form, selectedMac, busy, sessionExpired])
  function prepareDialog() {
    request.current?.abort()
    request.current = null
    setLoading(false)
    setFormError("")
    setRemovalConflict(false)
    setNotice("")
  }
  function open(form: RequestForm) {
    prepareDialog()
    setForm(form)
    setMessage("")
  }
  function mutationError(cause: unknown, fallback: string) {
    if (!mounted.current) return
    setFormError(cause instanceof Error ? cause.message : fallback)
    if (cause instanceof AccountError && cause.status === 401) {
      setSessionExpired(true)
      setError(
        "Sign in again, then refresh your account before making changes."
      )
    }
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
      mutationError(cause, "Unable to submit your request.")
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function removeMac() {
    if (!selectedMac || busy || sessionExpired || removalConflict) return
    setBusy(true)
    setFormError("")
    try {
      const result = await api<{ devices: CustomerAccount["devices"] }>({
        action: "remove-device",
        deviceId: selectedMac.id,
        sessionId: selectedMac.sessionId,
        expectedSessionRevision: selectedMac.revision,
      })
      if (!mounted.current) return
      if (
        !Array.isArray(result.devices) ||
        result.devices.some((device) => device.id === selectedMac.id)
      )
        throw new Error("Unable to confirm Mac removal. Refresh your account.")
      setAccount((current) =>
        current ? { ...current, devices: result.devices } : current
      )
      setSelectedMac(null)
      setNotice("Mac removed.")
      setLoading(true)
      await load()
    } catch (cause) {
      if (
        mounted.current &&
        cause instanceof AccountError &&
        cause.status === 409
      )
        setRemovalConflict(true)
      mutationError(cause, "Unable to remove this Mac.")
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function updateReminders() {
    if (!account || busy || sessionExpired) return
    setBusy(true)
    setError("")
    try {
      const result = await api<{ reminders: CustomerAccount["reminders"] }>({
        action: "set-reminders",
        enabled: !account.reminders.enabled,
        expectedRevision: account.reminders.revision,
      })
      if (!mounted.current) return
      if (
        !result.reminders ||
        typeof result.reminders.enabled !== "boolean" ||
        !Number.isSafeInteger(result.reminders.revision)
      )
        throw new Error(
          "Unable to confirm reminder settings. Refresh your account."
        )
      setAccount((current) =>
        current ? { ...current, reminders: result.reminders } : current
      )
      setNotice(
        result.reminders.enabled
          ? "Expiry reminders enabled."
          : "Expiry reminders disabled."
      )
    } catch (cause) {
      if (cause instanceof AccountError && cause.status === 401)
        setSessionExpired(true)
      if (cause instanceof AccountError && cause.status === 409) await load()
      setError(
        cause instanceof Error ? cause.message : "Unable to update reminders."
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const access = account?.access
  const devices = account?.devices ?? []
  const openRequests =
    account?.requests.filter((request) =>
      ["pending", "acknowledged"].includes(request.status)
    ) ?? []
  const renewalPending = openRequests.some(
    (request) => request.action === "renewal"
  )
  const active = access?.status === "active"
  const status = active
    ? "Active"
    : access?.status === "revoked"
      ? "Access revoked"
      : access?.status === "expired"
        ? "Expired"
        : "Free account"
  const requestLabel = access?.source ? "Request extension" : "Request access"
  return (
    <DashboardFrame
      mode="individual"
      className={styles.page}
      email={account?.user.email}
      disabled={busy}
      items={[
        {
          title: "Overview",
          url: "#overview",
          icon: <LayoutDashboard />,
          isActive: true,
        },
        { title: "Access", url: "#plan", icon: <CreditCard /> },
        { title: "Connected Macs", url: "#devices", icon: <Monitor /> },
        {
          title: "Request history",
          url: "#requests",
          icon: <History />,
          badge: openRequests.length,
        },
      ]}
    >
      <header className={styles.header}>
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-auto"
          />
          <span className="text-xs">Individual dashboard</span>
        </div>
      </header>
      <div className={styles.main} id="overview">
        <div className={styles.heading}>
          <div>
            <h1>Access &amp; connected Macs</h1>
            {account && (
              <p className={styles.mobileEmail}>{account.user.email}</p>
            )}
          </div>
          <Button
            variant="outline"
            className={styles.button}
            disabled={loading || busy}
            onClick={() => {
              setLoading(true)
              void load()
            }}
          >
            <RefreshCw className={loading ? styles.spinning : undefined} />
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
            {sessionExpired && (
              <>
                {" "}
                <SignInLink />
              </>
            )}
          </p>
        )}
        {notice && (
          <p role="status" className={styles.notice}>
            <Check size={16} />
            {notice}
          </p>
        )}
        {!account ? (
          <div role="status" className={styles.loading}>
            <span>
              {loading
                ? "Loading your account…"
                : "Select Refresh to try loading your account again."}
            </span>
            {loading && (
              <div className={styles.skeletonGrid}>
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </div>
            )}
          </div>
        ) : (
          <>
            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span>
                  <ShieldCheck />
                  Access
                </span>
                <strong>{status}</strong>
              </div>
              <div className={styles.metric}>
                <span>
                  <Monitor />
                  Connected devices
                </span>
                <strong>
                  {devices.length}
                  <em> / {2} Macs</em>
                </strong>
              </div>
              <div className={styles.metric}>
                <span>
                  <Clock3 />
                  Open requests
                </span>
                <strong>
                  {openRequests.length.toString().padStart(2, "0")}
                </strong>
              </div>
            </div>
            <div className={styles.columns}>
              <Card
                className={styles.planCard}
                id="plan"
                aria-labelledby="plan-title"
              >
                <CardHeader className={styles.cardHeader}>
                  <CardTitle>
                    <h2 id="plan-title">Your access</h2>
                  </CardTitle>
                  <Badge
                    variant="secondary"
                    className={active ? styles.active : styles.inactive}
                  >
                    {active && <span className={styles.statusDot} />}
                    {status}
                  </Badge>
                </CardHeader>
                <CardContent className={styles.planContent}>
                  <div className={styles.planIdentity}>
                    <span className={styles.planIcon}>
                      <GalleryVerticalEnd />
                    </span>
                    <div>
                      <p className={styles.plan}>
                        {access?.tier === "trial"
                          ? "Trial access"
                          : access?.tier === "standard"
                            ? "Standard access"
                            : "Free account"}
                      </p>
                    </div>
                  </div>
                  {access?.source ? (
                    <dl className={styles.planDetails}>
                      <div>
                        <dt>Access started</dt>
                        <dd>
                          <DateTime value={access.startsAt!} short />
                        </dd>
                      </div>
                      <div>
                        <dt>
                          {access.status === "expired"
                            ? "Access expired"
                            : "Access until"}
                        </dt>
                        <dd>
                          <DateTime value={access.endsAt!} short />
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className={styles.planHint}>
                      You can log in to the Mac app and join collaboration. An
                      administrator must grant access to open local projects or
                      host collaboration.
                    </p>
                  )}
                  <div className={styles.planActions}>
                    <Button
                      className={styles.button}
                      onClick={() => open({ action: "request-renewal" })}
                      disabled={busy || sessionExpired || renewalPending}
                    >
                      {renewalPending ? <Check /> : <ArrowRight />}
                      {renewalPending
                        ? "Request awaiting review"
                        : requestLabel}
                    </Button>
                  </div>
                  {account.reminders.revision > 0 && (
                    <div className={styles.renewalInfo}>
                      <CalendarDays size={17} />
                      <div>
                        <strong>Expiry reminders</strong>
                        <p>
                          Receive a reminder before trial access ends. This
                          preference does not extend access.
                        </p>
                        <Button
                          variant="outline"
                          className={styles.button}
                          disabled={busy || sessionExpired}
                          onClick={() => void updateReminders()}
                          aria-pressed={account.reminders.enabled}
                        >
                          {account.reminders.enabled
                            ? "Turn off reminders"
                            : "Turn on reminders"}
                        </Button>
                      </div>
                    </div>
                  )}
                  <p className={styles.billingNote}>
                    <ShieldCheck size={13} />
                    No automatic billing or payments here.
                  </p>
                </CardContent>
              </Card>
              <Card
                className={styles.devicesCard}
                id="devices"
                aria-labelledby="macs-title"
              >
                <CardHeader className={styles.cardHeader}>
                  <CardTitle>
                    <h2 id="macs-title">Connected Macs</h2>
                  </CardTitle>
                  <Badge variant="outline" className={styles.count}>
                    {devices.length} / {2}
                  </Badge>
                </CardHeader>
                <CardContent className={styles.deviceContent}>
                  {devices.length ? (
                    <ol className={styles.devices}>
                      {devices.map((device, index) => {
                        const label =
                          device.deviceName || `Computer ${index + 1}`
                        return (
                          <li key={device.id}>
                            <div className={styles.deviceHeading}>
                              <span className={styles.deviceIcon}>
                                <Monitor size={23} />
                              </span>
                              <div className="min-w-0 [overflow-wrap:anywhere]">
                                <strong>{label}</strong>
                                <span>
                                  Connected{" "}
                                  <DateTime value={device.activatedAt} short />
                                  {device.lastUsedAt != null && (
                                    <>
                                      <br />
                                      Last used{" "}
                                      <DateTime value={device.lastUsedAt} />
                                    </>
                                  )}
                                </span>
                              </div>
                            </div>
                            <details>
                              <summary>Mac identifier</summary>
                              <code className={styles.deviceId}>
                                {device.id}
                              </code>
                            </details>
                            <Button
                              variant="outline"
                              className={styles.deviceButton}
                              onClick={() => {
                                prepareDialog()
                                setSelectedMac({
                                  id: device.id,
                                  label,
                                  revision: device.revision,
                                  sessionId: device.sessionId,
                                })
                              }}
                              disabled={busy || sessionExpired || loading}
                              aria-label={`Remove ${label}`}
                            >
                              Remove Mac
                            </Button>
                          </li>
                        )
                      })}
                    </ol>
                  ) : (
                    <div className={styles.empty}>
                      <Monitor size={26} />
                      <strong>No Macs connected</strong>
                      <p>Sign in to Photodepot on your Mac to connect it.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
            <Card
              className={styles.requests}
              id="requests"
              aria-labelledby="requests-title"
            >
              <CardHeader className={styles.cardHeader}>
                <div>
                  <CardTitle>
                    <h2 id="requests-title">Your requests</h2>
                  </CardTitle>
                  <p className={styles.description}>Latest 50 requests</p>
                </div>
                <Badge variant="outline" className={styles.count}>
                  {account.requests.length} total
                </Badge>
              </CardHeader>
              <CardContent className={styles.requestContent}>
                {account.requests.length ? (
                  <ol className={styles.requestList}>
                    {account.requests.map((request) => (
                      <li key={request.id}>
                        <div className={styles.requestIcon}>
                          {request.action === "renewal" ? (
                            <CreditCard size={17} />
                          ) : (
                            <Monitor size={17} />
                          )}
                        </div>
                        <div className={styles.requestBody}>
                          <div className={styles.requestHeading}>
                            <strong>
                              {request.action === "renewal"
                                ? "Access extension"
                                : "Mac removal"}
                            </strong>
                            <Badge
                              variant="secondary"
                              className={
                                request.status === "resolved"
                                  ? styles.active
                                  : styles.requestStatus
                              }
                            >
                              {requestStatus(request)}
                            </Badge>
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
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className={styles.emptyRequests}>
                    <History size={22} />
                    <div>
                      <strong>No requests</strong>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
        <footer className={styles.footer}>
          <span>Dates use your browser’s time zone.</span>
        </footer>
      </div>
      {form && (
        <RequestDialog
          title={requestLabel}
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
      {selectedMac && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setSelectedMac(null)
          }}
          disablePointerDismissal={busy}
        >
          <DialogContent
            className={styles.modal}
            showCloseButton={false}
            initialFocus={removalCancel}
          >
            <DialogHeader className={styles.modalHeading}>
              <div className={styles.modalIcon}>
                <Monitor />
              </div>
              <DialogTitle className={styles.modalTitle}>
                Remove {selectedMac.label}?
              </DialogTitle>
              <DialogDescription className={styles.modalDescription}>
                End access to Photodepot on {selectedMac.label}. This computer
                must sign in again to reconnect.
              </DialogDescription>
            </DialogHeader>
            <code className={styles.deviceId}>{selectedMac.id}</code>
            {formError && (
              <p role="alert" className={styles.error}>
                {formError}
                {sessionExpired && (
                  <>
                    {" "}
                    <SignInLink />
                  </>
                )}
              </p>
            )}
            <DialogFooter className={styles.modalActions}>
              <Button
                ref={removalCancel}
                variant="outline"
                className={styles.button}
                disabled={busy}
                onClick={() => setSelectedMac(null)}
              >
                Go back
              </Button>
              {removalConflict && (
                <Button
                  className={styles.button}
                  disabled={busy}
                  onClick={() => {
                    setSelectedMac(null)
                    setLoading(true)
                    void load()
                  }}
                >
                  <RefreshCw />
                  Refresh account
                </Button>
              )}
              <Button
                variant="destructive"
                className={styles.button}
                disabled={busy || sessionExpired || removalConflict}
                onClick={() => void removeMac()}
              >
                {busy ? "Removing…" : "Remove Mac"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </DashboardFrame>
  )
}
