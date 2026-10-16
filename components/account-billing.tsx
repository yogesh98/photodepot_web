"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowRight, CreditCard, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import styles from "./account-billing.module.css"

type BillingInterval = "monthly" | "annual"
type BillingState = {
  enabled: boolean
  intervals: BillingInterval[]
  subscription: {
    status: string
    endsAt: number
    cancelAtPeriodEnd: boolean
  } | null
  hasCustomer: boolean
  portalEnabled?: boolean
  trialDays: number | null
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
const statusLabels: Record<string, string> = {
  active: "Active subscription",
  trialing: "Subscription trial",
  past_due: "Payment overdue",
  unpaid: "Unpaid subscription",
  incomplete: "Payment incomplete",
  paused: "Paused subscription",
  canceled: "Canceled subscription",
  incomplete_expired: "Subscription setup expired",
}
async function billingApi(body?: object, signal?: AbortSignal) {
  const response = await fetch("/api/account/billing", {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (response.status === 401)
    throw new BillingError(
      "Your session expired. Sign in again, then refresh billing.",
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
function readBilling(value: unknown): BillingState {
  const state = value as BillingState
  if (
    !state ||
    typeof state.enabled !== "boolean" ||
    !Array.isArray(state.intervals) ||
    state.intervals.some(
      (interval) => interval !== "monthly" && interval !== "annual"
    ) ||
    typeof state.hasCustomer !== "boolean" ||
    (state.portalEnabled !== undefined &&
      typeof state.portalEnabled !== "boolean") ||
    (state.trialDays !== null &&
      (!Number.isSafeInteger(state.trialDays) || state.trialDays <= 0)) ||
    (state.subscription !== null &&
      (!state.subscription ||
        typeof state.subscription.status !== "string" ||
        !Number.isSafeInteger(state.subscription.endsAt) ||
        state.subscription.endsAt < 0 ||
        typeof state.subscription.cancelAtPeriodEnd !== "boolean"))
  )
    throw new Error("Unable to read billing. Please try again.")
  return state
}
function stripeRedirect(value: unknown) {
  if (typeof value !== "string")
    throw new Error("Unable to open Stripe. Please try again.")
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.hostname !== "stripe.com" && !url.hostname.endsWith(".stripe.com"))
  )
    throw new Error("Unable to open Stripe. Please try again.")
  return url.href
}

export function AccountBilling({
  refreshVersion,
  disabled,
  onSubscriptionChange,
}: {
  refreshVersion: number
  disabled: boolean
  onSubscriptionChange: (subscribed: boolean | null) => void
}) {
  const [billing, setBilling] = useState<BillingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [sessionExpired, setSessionExpired] = useState(false)
  const [checkoutReturn, setCheckoutReturn] = useState<string | null>(null)
  const mounted = useRef(false)
  const request = useRef<AbortController | null>(null)
  const mutation = useRef(false)
  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const state = readBilling(await billingApi(undefined, controller.signal))
      if (!mounted.current || controller.signal.aborted) return
      setBilling(state)
      setError("")
      setSessionExpired(false)
      onSubscriptionChange(
        state.subscription !== null &&
          !terminalStatuses.has(state.subscription.status)
      )
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return
      onSubscriptionChange(null)
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
  }, [onSubscriptionChange])
  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => {
      if (mounted.current) {
        setCheckoutReturn(
          new URLSearchParams(window.location.search).get("billing")
        )
        void load()
      }
    })
    return () => {
      mounted.current = false
      request.current?.abort()
    }
  }, [load, refreshVersion])
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !mutation.current)
        void load()
    }
    const timer = window.setInterval(refresh, 30_000)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [load])
  async function openStripe(
    action: "checkout" | "portal",
    interval?: BillingInterval
  ) {
    if (mutation.current || disabled || sessionExpired || loading) return
    mutation.current = true
    setBusy(interval ?? action)
    setError("")
    try {
      const result = await billingApi({
        action,
        ...(interval ? { interval } : {}),
      })
      if (!mounted.current) return
      window.location.assign(stripeRedirect(result?.url))
    } catch (cause) {
      if (!mounted.current) return
      setError(
        cause instanceof Error ? cause.message : "Unable to open Stripe."
      )
      if (cause instanceof BillingError && cause.status === 401)
        setSessionExpired(true)
      mutation.current = false
      setBusy(null)
    }
  }
  if (billing?.enabled === false && !error) return null
  if (!billing && !error) return null
  const subscription = billing?.subscription
  const subscribed = subscription && !terminalStatuses.has(subscription.status)
  const controlsDisabled = disabled || loading || !!busy || sessionExpired
  return (
    <section
      className={styles.billing}
      aria-labelledby="billing-title"
      aria-busy={loading || !!busy}
    >
      <h3 id="billing-title">
        <CreditCard size={15} />
        Subscription billing
      </h3>
      {checkoutReturn === "success" && (
        <p role="status" className={styles.description}>
          Checking subscription status. Access updates after Stripe confirms
          your subscription.
        </p>
      )}
      {checkoutReturn === "canceled" && (
        <p role="status" className={styles.description}>
          Checkout closed. You can review a subscription whenever you are ready.
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
      {subscription && (
        <>
          <p className={styles.status}>
            {statusLabels[subscription.status] ?? "Subscription status pending"}
          </p>
          {subscription.endsAt > 0 ? (
            <p className={styles.description}>
              {subscription.status === "trialing"
                ? "Trial ends"
                : terminalStatuses.has(subscription.status)
                  ? "Subscription ended"
                  : "Current billing period ends"}{" "}
              <time dateTime={new Date(subscription.endsAt).toISOString()}>
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "long",
                }).format(subscription.endsAt)}
              </time>
              .
              {subscribed &&
                subscription.cancelAtPeriodEnd &&
                " Cancellation is scheduled for the end of this period."}
            </p>
          ) : (
            <p className={styles.description}>
              Subscription access is pending payment confirmation.
            </p>
          )}
          {["past_due", "unpaid", "incomplete", "paused"].includes(
            subscription.status
          ) && (
            <p className={styles.description}>
              Your subscription needs attention. Open billing to review its
              payment and access details.
            </p>
          )}
        </>
      )}
      {billing?.enabled && !subscribed && billing.intervals.length > 0 && (
        <>
          <p className={styles.description}>
            Choose a subscription to review the exact price, applicable tax, and
            renewal terms in Stripe Checkout before subscribing.
            {billing.trialDays &&
              ` A ${billing.trialDays}-day trial may be available; eligibility and terms are confirmed at checkout.`}
          </p>
          <div className={styles.actions}>
            {billing.intervals.map((interval) => (
              <Button
                key={interval}
                className={styles.button}
                variant="outline"
                disabled={controlsDisabled}
                onClick={() => void openStripe("checkout", interval)}
              >
                {busy === interval
                  ? "Opening Stripe…"
                  : `Review ${interval} subscription`}
                <ArrowRight />
              </Button>
            ))}
          </div>
        </>
      )}
      {billing?.hasCustomer && billing.portalEnabled !== false && (
        <div className={styles.actions}>
          <Button
            className={styles.button}
            variant="outline"
            disabled={controlsDisabled}
            onClick={() => void openStripe("portal")}
          >
            {busy === "portal" ? "Opening Stripe…" : "Manage billing"}
            <ArrowRight />
          </Button>
        </div>
      )}
      {!!busy && (
        <p role="status" className={styles.description}>
          Opening secure Stripe billing…
        </p>
      )}
      {error && (
        <Button
          className={styles.button}
          variant="outline"
          disabled={loading || !!busy}
          onClick={() => void load()}
        >
          <RefreshCw />
          {loading ? "Refreshing billing…" : "Refresh billing"}
        </Button>
      )}
    </section>
  )
}
