"use client"

import { DashboardFrame } from "@/components/dashboard-frame"
import { AccountBilling } from "@/components/account-billing"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { useCallback, useEffect, useRef, useState } from "react"
import { Check, CreditCard, Monitor, RefreshCw } from "lucide-react"
import type { CustomerAccount } from "@/lib/account-requests"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import styles from "./customer-account.module.css"

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
function SignInLink() {
  return (
    <a href="/api/account/auth/login" target="_blank" rel="noopener noreferrer">
      Sign in
    </a>
  )
}
export function CustomerAccountPage() {
  const [view, setView] = useState<"subscription" | "devices">("subscription")
  const [account, setAccount] = useState<CustomerAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [notice, setNotice] = useState("")
  const [selectedMac, setSelectedMac] = useState<SelectedMac | null>(null)
  const [removalConflict, setRemovalConflict] = useState(false)
  const [formError, setFormError] = useState("")
  const removalCancel = useRef<HTMLButtonElement>(null)
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    const syncView = () => {
      setView(window.location.hash === "#devices" ? "devices" : "subscription")
      setSelectedMac(null)
      setNotice("")
    }
    queueMicrotask(syncView)
    window.addEventListener("hashchange", syncView)
    return () => window.removeEventListener("hashchange", syncView)
  }, [])
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [view])
  const load = useCallback(async () => {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    try {
      const data = await api<CustomerAccount>(undefined, controller.signal)
      if (!data?.user?.email || !Array.isArray(data.devices) || !data.access)
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
  const refreshAccess = useCallback(() => {
    request.current?.abort()
    request.current = null
    void load()
  }, [load])
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
    if (selectedMac || busy || sessionExpired) return
    const poll = () => {
      if (document.visibilityState === "visible") void load()
    }
    const timer = window.setInterval(poll, 30_000)
    document.addEventListener("visibilitychange", poll)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [load, selectedMac, busy, sessionExpired])
  function prepareDialog() {
    request.current?.abort()
    request.current = null
    setLoading(false)
    setFormError("")
    setRemovalConflict(false)
    setNotice("")
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
  const access = account?.access
  const devices = account?.devices ?? []
  const active = access?.source === "workos" && access.status === "active"
  return (
    <DashboardFrame
      mode="individual"
      className={styles.page}
      email={account?.user.email}
      disabled={busy}
      items={[
        {
          title: "Subscription",
          url: "#subscription",
          icon: <CreditCard />,
          isActive: view === "subscription",
        },
        {
          title: "Authorized devices",
          url: "#devices",
          icon: <Monitor />,
          isActive: view === "devices",
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
      <main className={styles.main}>
        {error && (
          <div role="alert" className={styles.error}>
            <p>
              {error}
              {sessionExpired && (
                <>
                  {" "}
                  <SignInLink />
                </>
              )}
            </p>
            <Button
              variant="outline"
              className={styles.button}
              disabled={loading || busy}
              onClick={() => {
                setLoading(true)
                void load()
              }}
            >
              Try again
            </Button>
          </div>
        )}
        {notice && view === "devices" && (
          <p role="status" className={styles.notice}>
            <Check size={16} />
            {notice}
          </p>
        )}
        {!account ? (
          <div role="status" className={styles.loading}>
            {loading ? "Loading your account…" : "Unable to load your account."}
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
            {view === "subscription" && (
              <section
                id="subscription"
                aria-labelledby="subscription-title"
                className={styles.subscription}
              >
                <h1 id="subscription-title" className={styles.sectionTitle}>
                  Subscription
                </h1>
                <AccountBilling
                  hasAccess={active}
                  refreshVersion={0}
                  disabled={busy || sessionExpired}
                  onAccessRefresh={refreshAccess}
                />
              </section>
            )}
            {view === "devices" && (
              <section
                id="devices"
                aria-labelledby="devices-title"
                className={styles.devicesSection}
              >
                <h1 id="devices-title" className={styles.sectionTitle}>
                  Authorized devices
                </h1>
                <div className={styles.deviceList}>
                  {devices.length ? (
                    <ol className={styles.devices}>
                      {devices.map((device, index) => {
                        const label =
                          device.deviceName || `Computer ${index + 1}`
                        return (
                          <li key={device.id}>
                            <div className={styles.deviceHeading}>
                              <Monitor size={20} />
                              <div className="min-w-0 [overflow-wrap:anywhere]">
                                <strong>{label}</strong>
                                <span>
                                  {device.lastUsedAt != null ? (
                                    <>
                                      Last used{" "}
                                      <DateTime value={device.lastUsedAt} />
                                    </>
                                  ) : (
                                    <>
                                      Authorized{" "}
                                      <DateTime
                                        value={device.activatedAt}
                                        short
                                      />
                                    </>
                                  )}
                                </span>
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              className={styles.deviceButton}
                              aria-label={`Remove ${label}`}
                              disabled={busy || sessionExpired || loading}
                              onClick={() => {
                                prepareDialog()
                                setSelectedMac({
                                  id: device.id,
                                  label,
                                  revision: device.revision,
                                  sessionId: device.sessionId,
                                })
                              }}
                            >
                              Remove
                            </Button>
                          </li>
                        )
                      })}
                    </ol>
                  ) : (
                    <p className={styles.empty}>No authorized devices.</p>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </main>
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
