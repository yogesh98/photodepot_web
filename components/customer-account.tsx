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
import type {
  CustomerAccount,
  CustomerRequest,
  CustomerSubscription,
} from "@/lib/account-requests"
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
  sessionId?: string | null
}
type RenewalAction = "cancel-renewal" | "resume-renewal"
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
  busy,
  sessionExpired,
  error,
  message,
  onMessage,
  onClose,
  onSubmit,
}: {
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
            <DialogTitle className={styles.modalTitle}>
              Request renewal
            </DialogTitle>
            <DialogDescription className={styles.modalDescription}>
              Requires administrator approval. No payment or subscription change
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
  const [renewalAction, setRenewalAction] = useState<RenewalAction | null>(null)
  const [renewalConflict, setRenewalConflict] = useState(false)
  const [selectedMac, setSelectedMac] = useState<SelectedMac | null>(null)
  const [removalConflict, setRemovalConflict] = useState(false)
  const [message, setMessage] = useState("")
  const [formError, setFormError] = useState("")
  const renewalCancel = useRef<HTMLButtonElement>(null)
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
    if (form || renewalAction || selectedMac || busy || sessionExpired) return
    const poll = () => {
      if (document.visibilityState === "visible") void load()
    }
    const timer = window.setInterval(poll, 30_000)
    document.addEventListener("visibilitychange", poll)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [load, form, renewalAction, selectedMac, busy, sessionExpired])
  function prepareDialog() {
    request.current?.abort()
    request.current = null
    setLoading(false)
    setFormError("")
    setRenewalConflict(false)
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
      const result = await api<{
        subscription: CustomerSubscription | null
        devices?: CustomerAccount["devices"]
      }>({
        action: "remove-device",
        deviceId: selectedMac.id,
        expectedRevision: selectedMac.revision,
        ...(selectedMac.sessionId
          ? {
              sessionId: selectedMac.sessionId,
              expectedSessionRevision: selectedMac.revision,
            }
          : {}),
      })
      if (!mounted.current) return
      if (
        !Array.isArray(result.devices ?? result.subscription?.devices) ||
        (result.devices ?? result.subscription?.devices ?? []).some(
          (device) => device.id === selectedMac.id
        )
      )
        throw new Error("Unable to confirm Mac removal. Refresh your account.")
      setAccount((current) =>
        current
          ? {
              ...current,
              subscription: result.subscription,
              devices: result.devices,
            }
          : current
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
  async function updateRenewal() {
    if (
      !renewalAction ||
      !account?.subscription ||
      busy ||
      sessionExpired ||
      renewalConflict
    )
      return
    setBusy(true)
    setFormError("")
    try {
      const result = await api<{ subscription: CustomerSubscription }>({
        action: renewalAction,
        expectedRevision: account.subscription.revision,
      })
      if (!mounted.current) return
      setAccount((current) =>
        current ? { ...current, subscription: result.subscription } : current
      )
      setNotice(
        renewalAction === "cancel-renewal"
          ? "Renewal canceled. Local project access continues until your subscription ends. You can still log in and join collaboration afterward."
          : "Renewal preference restored. Your administrator will still need to approve and extend access."
      )
      setRenewalAction(null)
      setLoading(true)
      await load()
    } catch (cause) {
      if (
        mounted.current &&
        cause instanceof AccountError &&
        cause.status === 409
      )
        setRenewalConflict(true)
      mutationError(cause, "Unable to update your renewal preference.")
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const subscription = account?.subscription
  const devices =
    account?.devices ??
    subscription?.devices.map((device) => ({
      ...device,
      deviceName: null,
      lastUsedAt: null,
      sessionId: null,
      revision: subscription.revision,
    })) ??
    []
  const openRequests =
    account?.requests.filter((request) =>
      ["pending", "acknowledged"].includes(request.status)
    ) ?? []
  const renewalPending = openRequests.some(
    (request) => request.action === "renewal"
  )
  const active = subscription?.status === "active"
  const canceled = subscription?.cancelAtPeriodEnd
  const status = active
    ? "Active"
    : subscription?.status === "revoked"
      ? "Subscription revoked"
      : subscription
        ? "Expired"
        : "No subscription"
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
        { title: "Subscription", url: "#plan", icon: <CreditCard /> },
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
            <h1>Plan &amp; connected Macs</h1>
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
                  Subscription
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
                  <em> / {subscription?.deviceLimit ?? 2} Macs</em>
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
                    <h2 id="plan-title">Your subscription</h2>
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
                        {subscription
                          ? subscription.type === "trial"
                            ? "Free trial"
                            : "Standard subscription"
                          : "No plan assigned"}
                      </p>
                    </div>
                  </div>
                  {subscription ? (
                    <dl className={styles.planDetails}>
                      <div>
                        <dt>Access started</dt>
                        <dd>
                          <DateTime value={subscription.startsAt} short />
                        </dd>
                      </div>
                      <div>
                        <dt>
                          {subscription.status === "expired"
                            ? "Access expired"
                            : "Access until"}
                        </dt>
                        <dd>
                          <DateTime value={subscription.endsAt} short />
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className={styles.planHint}>
                      You can log in to the Mac app and join collaboration. An
                      administrator must assign a subscription to open local
                      projects or host collaboration.
                    </p>
                  )}
                  {active && (
                    <div
                      className={
                        canceled ? styles.renewalCanceled : styles.renewalInfo
                      }
                    >
                      <CalendarDays size={17} />
                      <div>
                        <strong>
                          {canceled ? "Renewal canceled" : "Manual renewal"}
                        </strong>
                        <p>
                          {canceled ? (
                            <>
                              Your access remains active until{" "}
                              <DateTime value={subscription!.endsAt} short />.
                              Resume renewal before requesting an extension.
                            </>
                          ) : (
                            "Renewal requests require administrator approval."
                          )}
                        </p>
                      </div>
                    </div>
                  )}
                  <div className={styles.planActions}>
                    <Button
                      className={styles.button}
                      onClick={() => open({ action: "request-renewal" })}
                      disabled={
                        busy ||
                        sessionExpired ||
                        renewalPending ||
                        Boolean(active && canceled)
                      }
                      title={
                        active && canceled
                          ? "Resume renewal before requesting an extension."
                          : undefined
                      }
                    >
                      {renewalPending ? <Check /> : <ArrowRight />}
                      {renewalPending ? "Renewal requested" : "Request renewal"}
                    </Button>
                    {active && (
                      <Button
                        variant="ghost"
                        className={styles.button}
                        disabled={busy || sessionExpired}
                        onClick={() => {
                          prepareDialog()
                          setRenewalAction(
                            canceled ? "resume-renewal" : "cancel-renewal"
                          )
                        }}
                      >
                        {canceled ? "Resume renewal" : "Cancel renewal"}
                      </Button>
                    )}
                  </div>
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
                    {devices.length} / {subscription?.deviceLimit ?? 2}
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
                                  revision:
                                    "revision" in device
                                      ? (device.revision as number)
                                      : subscription!.revision,
                                  sessionId:
                                    "sessionId" in device
                                      ? (device.sessionId as string | null)
                                      : undefined,
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
                                ? "Subscription renewal"
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
      {renewalAction && subscription && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setRenewalAction(null)
          }}
          disablePointerDismissal={busy}
        >
          <DialogContent
            className={styles.modal}
            showCloseButton={false}
            initialFocus={renewalCancel}
          >
            <DialogHeader className={styles.modalHeading}>
              <div className={styles.modalIcon}>
                <CalendarDays />
              </div>
              <DialogTitle className={styles.modalTitle}>
                {renewalAction === "cancel-renewal"
                  ? "Cancel your renewal?"
                  : "Resume your renewal?"}
              </DialogTitle>
              <DialogDescription className={styles.modalDescription}>
                {renewalAction === "cancel-renewal" ? (
                  <>
                    Your current subscription stays active until{" "}
                    <DateTime value={subscription.endsAt} />. This tells the
                    administrator you do not want to renew. It will not remove
                    your Macs or end access early.
                  </>
                ) : (
                  <>
                    This restores your renewal preference. Submit a renewal
                    request when you want an administrator to extend access.
                    Your current end date remains{" "}
                    <DateTime value={subscription.endsAt} />. No payment is
                    collected.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
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
                ref={renewalCancel}
                variant="outline"
                className={styles.button}
                disabled={busy}
                onClick={() => setRenewalAction(null)}
              >
                Go back
              </Button>
              {renewalConflict && (
                <Button
                  className={styles.button}
                  disabled={busy}
                  onClick={() => {
                    setRenewalAction(null)
                    setLoading(true)
                    void load()
                  }}
                >
                  <RefreshCw />
                  Refresh account
                </Button>
              )}
              <Button
                variant={
                  renewalAction === "cancel-renewal" ? "destructive" : "default"
                }
                className={styles.button}
                disabled={busy || sessionExpired || renewalConflict}
                onClick={() => void updateRenewal()}
              >
                {busy
                  ? "Saving…"
                  : renewalAction === "cancel-renewal"
                    ? "Confirm cancellation"
                    : "Confirm renewal preference"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </DashboardFrame>
  )
}
