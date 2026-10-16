"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowRight, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import styles from "./account-billing.module.css"

type BillingInterval = "monthly" | "annual"
type BillingPrice = { amount: number; currency: string }
type BillingState = {
  enabled: boolean
  intervals: BillingInterval[]
  prices?: Partial<Record<BillingInterval, BillingPrice>>
  subscription: {
    status: string
    endsAt: number
    cancelAtPeriodEnd: boolean
    interval?: BillingInterval | null
    amount?: number | null
    currency?: string | null
    discountsApplied?: boolean
  } | null
  hasCustomer: boolean
  portalEnabled?: boolean
  trialDays: number | null
  accessConnected: boolean
  accessUnavailable?: boolean
  managedBy: "workos"
}
class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}
const terminalStatuses = new Set(["canceled", "incomplete_expired"])
const attentionStatuses = new Set([
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
])
const authorizePaths = new Set([
  "/api/account/billing/authorize",
  "/api/account/billing/authorize?action=checkout&interval=monthly",
  "/api/account/billing/authorize?action=checkout&interval=annual",
])
async function billingApi(
  body?: object,
  signal?: AbortSignal,
  refreshAccess = false
) {
  const response = await fetch(
    `/api/account/billing${!body && refreshAccess ? "?refresh=true" : ""}`,
    {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  )
  if (response.status === 401)
    throw new BillingError(
      "Your session expired. Sign in again to continue.",
      401
    )
  let result
  try {
    result = await response.json()
  } catch {
    throw new BillingError(
      "Unable to read billing. Please try again.",
      response.status
    )
  }
  if (!response.ok)
    throw new BillingError(
      typeof result?.error === "string"
        ? result.error
        : "Billing is temporarily unavailable. Please try again.",
      response.status
    )
  return result
}
function validPrice(price: unknown): price is BillingPrice {
  const value = price as BillingPrice
  return (
    !!value &&
    Number.isSafeInteger(value.amount) &&
    value.amount >= 0 &&
    typeof value.currency === "string" &&
    /^[a-z]{3}$/i.test(value.currency)
  )
}
function readBilling(value: unknown): BillingState {
  const state = value as BillingState
  if (
    !state ||
    typeof state.enabled !== "boolean" ||
    !Array.isArray(state.intervals) ||
    state.intervals.some(
      (interval) => interval !== "monthly" && interval !== "annual"
    ) ||
    (state.prices !== undefined &&
      (!state.prices ||
        typeof state.prices !== "object" ||
        Object.values(state.prices).some((price) => !validPrice(price)))) ||
    typeof state.hasCustomer !== "boolean" ||
    typeof state.accessConnected !== "boolean" ||
    (state.accessUnavailable !== undefined &&
      typeof state.accessUnavailable !== "boolean") ||
    state.managedBy !== "workos" ||
    (state.portalEnabled !== undefined &&
      typeof state.portalEnabled !== "boolean") ||
    (state.trialDays !== null &&
      (!Number.isSafeInteger(state.trialDays) || state.trialDays <= 0)) ||
    (state.subscription !== null &&
      (!state.subscription ||
        typeof state.subscription.status !== "string" ||
        !Number.isSafeInteger(state.subscription.endsAt) ||
        state.subscription.endsAt < 0 ||
        typeof state.subscription.cancelAtPeriodEnd !== "boolean" ||
        (state.subscription.interval != null &&
          !["monthly", "annual"].includes(state.subscription.interval)) ||
        (state.subscription.amount != null &&
          (!Number.isSafeInteger(state.subscription.amount) ||
            state.subscription.amount < 0)) ||
        (state.subscription.currency != null &&
          !/^[a-z]{3}$/i.test(state.subscription.currency))))
  )
    throw new Error("Unable to read billing. Please try again.")
  return state
}
function billingRedirect(value: unknown, provider: unknown) {
  if (provider === "workos") {
    if (typeof value !== "string" || !authorizePaths.has(value))
      throw new Error("Unable to confirm your account. Please try again.")
    return value
  }
  if (provider !== undefined && provider !== "stripe")
    throw new Error("Unable to open billing. Please try again.")
  if (typeof value !== "string")
    throw new Error("Unable to open Stripe. Please try again.")
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.hostname !== "checkout.stripe.com" &&
      url.hostname !== "billing.stripe.com")
  )
    throw new Error("Unable to open Stripe. Please try again.")
  return url.href
}
function money(price: BillingPrice) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: price.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(price.amount / 100)
}

export function AccountBilling({
  refreshVersion,
  disabled,
  hasAccess,
  accessUnavailable: accountAccessUnavailable = false,
  onAccessRefresh,
}: {
  refreshVersion: number
  disabled: boolean
  hasAccess: boolean
  accessUnavailable?: boolean
  onAccessRefresh: () => void
}) {
  const [billing, setBilling] = useState<BillingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [confirmationDelayed, setConfirmationDelayed] = useState(false)
  const [checkoutReturn, setCheckoutReturn] = useState<string | null>(null)
  const mounted = useRef(false)
  const request = useRef<AbortController | null>(null)
  const mutation = useRef(false)
  const load = useCallback(
    async (refreshAccess = false) => {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      setLoading(true)
      try {
        const state = readBilling(
          await billingApi(undefined, controller.signal, refreshAccess)
        )
        if (!mounted.current || controller.signal.aborted) return
        setBilling(state)
        setError("")
        setSessionExpired(false)
        if (refreshAccess) onAccessRefresh()
      } catch (cause) {
        if (!mounted.current || controller.signal.aborted) return
        setError(
          cause instanceof Error ? cause.message : "Unable to load billing."
        )
        if (cause instanceof BillingError && cause.status === 401)
          setSessionExpired(true)
      } finally {
        if (request.current === controller) {
          request.current = null
          if (mounted.current) setLoading(false)
        }
      }
    },
    [onAccessRefresh]
  )
  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => {
      if (!mounted.current) return
      const returned = new URLSearchParams(window.location.search).get(
        "billing"
      )
      setCheckoutReturn(returned)
      void load(
        refreshVersion > 0 || returned === "success" || returned === "return"
      )
    })
    return () => {
      mounted.current = false
      request.current?.abort()
    }
  }, [load, refreshVersion])
  const subscription = billing?.subscription
  const subscribed =
    !!subscription && !terminalStatuses.has(subscription.status)
  const healthy =
    subscribed && ["active", "trialing"].includes(subscription.status)
  const accessUnavailable =
    accountAccessUnavailable || billing?.accessUnavailable === true
  const confirming =
    healthy &&
    !hasAccess &&
    !accessUnavailable &&
    billing?.accessConnected !== false
  useEffect(() => {
    const refresh = () => {
      if (
        document.visibilityState === "visible" &&
        !mutation.current &&
        !request.current
      )
        void load()
    }
    const timer = window.setInterval(refresh, 30_000)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [load])
  useEffect(() => {
    queueMicrotask(() => setConfirmationDelayed(false))
    if (!confirming || sessionExpired) return
    let attempts = 0
    const timer = window.setInterval(() => {
      if (
        request.current ||
        mutation.current ||
        document.visibilityState !== "visible"
      )
        return
      if (++attempts >= 12) {
        window.clearInterval(timer)
        setConfirmationDelayed(true)
      }
      void load(true)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [confirming, load, sessionExpired])
  async function openBilling(
    action: "checkout" | "portal" | "connect" | "upgrade" | "cancel",
    interval?: BillingInterval
  ) {
    if (mutation.current || disabled || sessionExpired || loading) return
    mutation.current = true
    setBusy(interval ? `${action}-${interval}` : action)
    setError("")
    try {
      const result = await billingApi({
        action,
        ...(interval ? { interval } : {}),
      })
      if (mounted.current)
        window.location.assign(billingRedirect(result?.url, result?.provider))
    } catch (cause) {
      if (!mounted.current) return
      setError(
        cause instanceof Error ? cause.message : "Unable to open billing."
      )
      if (cause instanceof BillingError && cause.status === 401)
        setSessionExpired(true)
      mutation.current = false
      setBusy(null)
    }
  }
  const intervals = billing?.intervals ?? []
  const monthly = billing?.prices?.monthly
  const annual = billing?.prices?.annual
  const twoMonthsFree =
    monthly &&
    annual &&
    monthly.currency === annual.currency &&
    annual.amount === monthly.amount * 10
  const currentInterval = subscribed ? (subscription.interval ?? null) : null
  const controlsDisabled = disabled || loading || !!busy || sessionExpired
  const canManage = billing?.hasCustomer && billing.portalEnabled !== false
  const reconnect =
    subscribed && !hasAccess && billing?.accessConnected === false
  const attention = !!subscription && attentionStatuses.has(subscription.status)
  const plans = [
    { key: "free", name: "Free", description: "Join shared projects." },
    {
      key: "monthly",
      name: "Monthly",
      description: "Local projects, hosting, and 2 Macs.",
    },
    {
      key: "annual",
      name: "Yearly",
      description: "Local projects, hosting, and 2 Macs.",
    },
  ] as const
  function renewal() {
    if (!subscription || subscription.endsAt <= 0) return null
    return (
      <p className={styles.note}>
        {subscription.cancelAtPeriodEnd
          ? "Ends"
          : subscription.status === "trialing"
            ? "Trial ends"
            : "Renews"}{" "}
        <time dateTime={new Date(subscription.endsAt).toISOString()}>
          {new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
            subscription.endsAt
          )}
        </time>
      </p>
    )
  }
  return (
    <div className={styles.billing} aria-busy={loading || !!busy}>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
          {sessionExpired && (
            <>
              {" "}
              <a href="/api/account/auth/login">Sign in</a>
            </>
          )}
        </p>
      )}
      {!billing && loading && (
        <p role="status" className={styles.note}>
          Loading your subscription…
        </p>
      )}
      {checkoutReturn === "canceled" && !subscribed && (
        <p role="status" className={styles.note}>
          Checkout closed. Your plan hasn’t changed.
        </p>
      )}
      {checkoutReturn === "success" && hasAccess && !accessUnavailable && (
        <p role="status" className={styles.success}>
          Your subscription is active.
        </p>
      )}
      {accessUnavailable && (
        <p role="status" className={styles.note}>
          We couldn’t check subscription access. You can still manage your
          subscription and authorized devices.
        </p>
      )}
      <div className={styles.plans}>
        {plans.map((plan) => {
          const free = plan.key === "free"
          const interval = free ? null : plan.key
          const current =
            !!billing && (free ? !subscribed : currentInterval === interval)
          const configured = interval ? billing?.prices?.[interval] : undefined
          const price =
            current && subscription?.amount != null && subscription.currency
              ? { amount: subscription.amount, currency: subscription.currency }
              : configured
          const available =
            !!interval &&
            !!billing?.enabled &&
            intervals.includes(interval) &&
            !!configured
          const higher =
            !free &&
            (!subscribed ||
              (currentInterval === "monthly" && interval === "annual"))
          const purchaseAction = subscribed ? "upgrade" : "checkout"
          const opening = !!interval && busy === `${purchaseAction}-${interval}`
          return (
            <article
              key={plan.key}
              className={`${styles.plan} ${current ? styles.current : ""}`}
              aria-labelledby={`subscription-${plan.key}`}
            >
              <div className={styles.planHeading}>
                <h3 id={`subscription-${plan.key}`}>{plan.name}</h3>
                {current && (
                  <span className={styles.currentLabel}>Current plan</span>
                )}
              </div>
              <p className={styles.price}>
                {free ? "$0" : price ? money(price) : "—"}
                {!free && (
                  <span> / {interval === "annual" ? "year" : "month"}</span>
                )}
              </p>
              <p className={styles.description}>{plan.description}</p>
              <div className={styles.planNotes}>
                {interval === "annual" && twoMonthsFree && (
                  <p className={styles.saving}>2 months free</p>
                )}
                {current && !free && subscription?.discountsApplied && (
                  <p className={styles.note}>Price before your discount.</p>
                )}
                {current && !free && renewal()}
                {current && confirming && (
                  <p role="status" className={styles.note}>
                    {confirmationDelayed
                      ? "Subscription access is taking longer than expected. Try again in a moment."
                      : "Activating your subscription…"}
                  </p>
                )}
              </div>
              <div className={styles.planAction}>
                {current && !free ? (
                  <Button
                    className={styles.button}
                    variant="outline"
                    disabled={
                      controlsDisabled ||
                      !canManage ||
                      subscription?.cancelAtPeriodEnd
                    }
                    onClick={() => void openBilling("cancel")}
                  >
                    {busy === "cancel"
                      ? "Opening cancellation…"
                      : subscription?.cancelAtPeriodEnd
                        ? "Cancellation scheduled"
                        : "Cancel"}
                  </Button>
                ) : higher ? (
                  <Button
                    className={styles.button}
                    disabled={
                      controlsDisabled ||
                      !available ||
                      (subscribed && !canManage)
                    }
                    onClick={() =>
                      interval && void openBilling(purchaseAction, interval)
                    }
                  >
                    {opening ? "Opening…" : "Upgrade"}
                    <ArrowRight />
                  </Button>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
      {billing?.enabled && !subscribed && (
        <p className={styles.terms}>
          USD · Paid plans renew automatically. Tax calculated at checkout.
        </p>
      )}
      {billing && !billing.enabled && !subscribed && (
        <p className={styles.note}>
          Subscriptions are temporarily unavailable.
        </p>
      )}
      {canManage && !attention && (!subscribed || currentInterval) && (
        <div className={styles.recovery}>
          <Button
            className={styles.button}
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => void openBilling("portal")}
          >
            {busy === "portal" ? "Opening billing…" : "Manage billing"}
          </Button>
        </div>
      )}
      {attention && (
        <div className={styles.recovery}>
          <p className={styles.note}>Your payment needs attention.</p>
          {canManage && (
            <Button
              className={styles.button}
              variant="outline"
              disabled={controlsDisabled}
              onClick={() => void openBilling("portal")}
            >
              Update payment method
            </Button>
          )}
        </div>
      )}
      {reconnect && (
        <div className={styles.recovery}>
          <p className={styles.note}>
            Confirm your account to restore subscription access.
          </p>
          <Button
            className={styles.button}
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => void openBilling("connect")}
          >
            Confirm your account
          </Button>
        </div>
      )}
      {subscribed && !currentInterval && (
        <div className={styles.recovery}>
          <p className={styles.note}>Your subscription details need review.</p>
          {canManage && (
            <Button
              className={styles.button}
              variant="outline"
              disabled={controlsDisabled}
              onClick={() => void openBilling("portal")}
            >
              Review billing
            </Button>
          )}
        </div>
      )}
      {(error || accessUnavailable || (confirming && confirmationDelayed)) && (
        <Button
          className={styles.button}
          variant="outline"
          disabled={loading || !!busy}
          onClick={() => void load(true)}
        >
          <RefreshCw />
          {loading ? "Trying again…" : "Try again"}
        </Button>
      )}
    </div>
  )
}
