import Stripe from "stripe"
import { createWorkOS } from "@workos-inc/node"
import type { Env } from "./cloudflare.ts"
import {
  BillingConflictError,
  BillingUnavailableError,
  getBillingCustomer,
  getBillingSubscription,
  hasUsedManualTrial,
  lockBillingAccount,
  unlockBillingAccount,
  updateBillingCustomer,
  type BillingCustomer,
} from "./stripe-billing-store.ts"

export type BillingInterval = "monthly" | "annual"
export interface BillingIdentity {
  userId: string
  email: string
}
interface BillingConfig {
  secret: string
  webhookSecret: string
  live: boolean
  origin: string
  prices: Partial<Record<BillingInterval, string>>
  automaticTax: boolean
  trialDays: number | null
  portalConfiguration: string | undefined
}
interface BillingDependencies {
  stripe?: Stripe
  workos?: ReturnType<typeof createWorkOS>
}
const terminalStatuses = new Set(["canceled", "incomplete_expired"])
const subscriptionStatuses = new Set([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
])

export function billingConfiguration(
  env: Env,
  existingBilling = false
): BillingConfig | null {
  if (
    env.PHOTODEPOT_STRIPE_ENABLED !== "true" &&
    !(existingBilling && env.STRIPE_SECRET_KEY)
  )
    return null
  const fail = () => {
    throw new BillingUnavailableError("Billing is not configured.")
  }
  const mode = env.PHOTODEPOT_STRIPE_MODE ?? "test"
  if (mode !== "test" && mode !== "live") return fail()
  const live = mode === "live"
  const secret = env.STRIPE_SECRET_KEY ?? ""
  if (
    !new RegExp(`^(?:sk|rk)_${live ? "live" : "test"}_[A-Za-z0-9]+$`).test(
      secret
    )
  )
    return fail()
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? ""
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) return fail()
  let origin: string
  try {
    const url = new URL(env.PHOTODEPOT_STRIPE_ORIGIN ?? "")
    const local =
      !live &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    if (
      (url.protocol !== "https:" && !local) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return fail()
    origin = url.origin
  } catch {
    return fail()
  }
  const prices: BillingConfig["prices"] = {}
  for (const [interval, value] of [
    ["monthly", env.STRIPE_PRICE_MONTHLY],
    ["annual", env.STRIPE_PRICE_ANNUAL],
  ] as const) {
    if (value && !/^price_[A-Za-z0-9]+$/.test(value)) return fail()
    if (value) prices[interval] = value
  }
  if (
    !Object.keys(prices).length ||
    (prices.monthly && prices.monthly === prices.annual)
  )
    return fail()
  const tax = env.PHOTODEPOT_STRIPE_AUTOMATIC_TAX ?? "true"
  if (tax !== "true" && tax !== "false") return fail()
  const suppliedDays = env.PHOTODEPOT_STRIPE_TRIAL_DAYS
  const trialDays = suppliedDays ? Number(suppliedDays) : null
  if (
    trialDays !== null &&
    (!/^\d+$/.test(suppliedDays!) ||
      !Number.isInteger(trialDays) ||
      trialDays < 1 ||
      trialDays > 730)
  )
    return fail()
  const portalConfiguration = env.STRIPE_PORTAL_CONFIGURATION_ID
  if (portalConfiguration && !/^bpc_[A-Za-z0-9]+$/.test(portalConfiguration))
    return fail()
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID) return fail()
  return {
    secret,
    webhookSecret,
    live,
    origin,
    prices,
    automaticTax: tax === "true",
    trialDays,
    portalConfiguration,
  }
}

export function createBillingStripe(config: BillingConfig) {
  return new Stripe(config.secret, {
    httpClient: Stripe.createFetchHttpClient(),
    timeout: 10_000,
    maxNetworkRetries: 1,
  })
}

export async function billingSummary(env: Env, userId: string) {
  const config = billingConfiguration(env, true)
  if (!config)
    return {
      enabled: false,
      intervals: [],
      subscription: null,
      hasCustomer: false,
      portalEnabled: false,
      trialDays: null,
    }
  const [customer, subscription, manualTrial] = await Promise.all([
    getBillingCustomer(env.DB, userId),
    getBillingSubscription(env.DB, userId),
    config.trialDays ? hasUsedManualTrial(env.DB, userId) : false,
  ])
  return {
    enabled:
      env.PHOTODEPOT_STRIPE_ENABLED === "true" ||
      Boolean(customer?.stripe_customer_id),
    intervals:
      env.PHOTODEPOT_STRIPE_ENABLED === "true"
        ? (Object.keys(config.prices) as BillingInterval[])
        : [],
    subscription: subscription
      ? {
          status: subscription.status,
          endsAt: subscription.endsAt,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
    hasCustomer: Boolean(customer?.stripe_customer_id),
    portalEnabled: Boolean(config.portalConfiguration),
    trialDays:
      env.PHOTODEPOT_STRIPE_ENABLED !== "true" ||
      customer?.trial_used ||
      manualTrial
        ? null
        : config.trialDays,
  }
}

function requiredConfig(env: Env) {
  const config = billingConfiguration(env)
  if (!config) throw new BillingUnavailableError("Billing is not enabled.")
  return config
}

function safeStripeUrl(value: string | null, kind: "checkout" | "portal") {
  if (!value)
    throw new BillingUnavailableError("Stripe did not return a billing URL.")
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.hostname !==
      (kind === "checkout" ? "checkout.stripe.com" : "billing.stripe.com") ||
    url.username ||
    url.password
  )
    throw new BillingUnavailableError("Stripe returned an invalid billing URL.")
  return value
}

async function ensureCustomer(
  env: Env,
  config: BillingConfig,
  identity: BillingIdentity,
  row: BillingCustomer,
  token: string,
  deps: BillingDependencies
) {
  const stripe = deps.stripe ?? createBillingStripe(config)
  const workos =
    deps.workos ??
    createWorkOS({
      apiKey: env.WORKOS_API_KEY!,
      clientId: env.WORKOS_CLIENT_ID!,
      timeout: 5000,
      maxRetries: 0,
    })
  const externalId = `photodepot-billing:${identity.userId}`
  let organization
  try {
    organization =
      await workos.organizations.getOrganizationByExternalId(externalId)
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("status" in error) ||
      error.status !== 404
    )
      throw error
    organization = await workos.organizations.createOrganization(
      { name: "Photodepot personal account", externalId },
      { idempotencyKey: externalId }
    )
  }
  if (
    organization.id === env.WORKOS_ADMIN_ORGANIZATION_ID ||
    organization.externalId !== externalId ||
    (row.workos_organization_id &&
      row.workos_organization_id !== organization.id)
  )
    throw new BillingUnavailableError(
      "Billing organization does not match this account."
    )
  await updateBillingCustomer(env.DB, identity.userId, token, {
    workos_organization_id: organization.id,
  })
  let customerId = row.stripe_customer_id
  if (!customerId) {
    // Stripe retains idempotency keys for at least 24 hours. An unresolved
    // older creation must be reconciled manually before retrying its side effect.
    if (
      row.customer_create_started_at &&
      Date.now() - row.customer_create_started_at >= 23 * 60 * 60 * 1000
    )
      throw new BillingUnavailableError(
        "Customer setup needs reconciliation. Please contact support."
      )
    if (!row.customer_create_started_at)
      await updateBillingCustomer(env.DB, identity.userId, token, {
        customer_create_started_at: Date.now(),
      })
    const customer = await stripe.customers.create(
      {
        email: identity.email,
        metadata: {
          photodepot_user_id: identity.userId,
          workos_organization_id: organization.id,
        },
      },
      { idempotencyKey: `photodepot-customer-${row.customer_create_token}` }
    )
    if (customer.livemode !== config.live)
      throw new BillingUnavailableError("Stripe mode mismatch.")
    customerId = customer.id
    await updateBillingCustomer(env.DB, identity.userId, token, {
      stripe_customer_id: customerId,
    })
  }
  if (
    organization.stripeCustomerId &&
    organization.stripeCustomerId !== customerId
  )
    throw new BillingUnavailableError(
      "Billing customer does not match this account."
    )
  if (organization.stripeCustomerId !== customerId)
    await workos.organizations.updateOrganization({
      organization: organization.id,
      stripeCustomerId: customerId,
    })
  return { stripe, customerId }
}

/** Creates one reusable hosted session per account, behind a database lease. */
export async function createBillingCheckout(
  env: Env,
  identity: BillingIdentity,
  interval: BillingInterval,
  deps: BillingDependencies = {}
) {
  const config = requiredConfig(env)
  const priceId = config.prices[interval]
  if (!priceId) throw new TypeError("Choose an available billing interval.")
  const { customer: row, token } = await lockBillingAccount(
    env.DB,
    identity.userId,
    true
  )
  try {
    const stored = await getBillingSubscription(env.DB, identity.userId)
    if (stored && !terminalStatuses.has(stored.status))
      throw new BillingConflictError(
        "Manage your current subscription in billing settings."
      )
    const { stripe, customerId } = await ensureCustomer(
      env,
      config,
      identity,
      row,
      token,
      deps
    )
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    })
    if (
      subscriptions.has_more ||
      subscriptions.data.some((sub) => !terminalStatuses.has(sub.status))
    )
      throw new BillingConflictError(
        "A subscription already exists. Manage it in billing settings."
      )
    const stripeTrialHistory = subscriptions.data.some((sub) =>
      Boolean(sub.trial_start)
    )
    if (stripeTrialHistory && !row.trial_used)
      await updateBillingCustomer(env.DB, identity.userId, token, {
        trial_used: 1,
      })
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] })
    if (
      !price.active ||
      price.livemode !== config.live ||
      price.type !== "recurring" ||
      price.recurring?.interval !==
        (interval === "monthly" ? "month" : "year") ||
      price.recurring?.interval_count !== 1 ||
      price.tax_behavior === "unspecified"
    )
      throw new BillingUnavailableError(
        "The configured Stripe price needs review."
      )
    if (
      typeof price.product !== "object" ||
      price.product.deleted ||
      !price.product.active ||
      (config.automaticTax && !price.product.tax_code)
    )
      throw new BillingUnavailableError(
        "The configured Stripe product needs a tax code and must be active."
      )
    if (row.checkout_session_id) {
      const session = await stripe.checkout.sessions.retrieve(
        row.checkout_session_id
      )
      if (
        session.livemode !== config.live ||
        objectId(session.customer) !== customerId
      )
        throw new BillingUnavailableError("Checkout customer mismatch.")
      if (session.status === "complete") {
        const completedSubscription = subscriptions.data.find(
          (sub) => sub.id === objectId(session.subscription)
        )
        if (
          !completedSubscription ||
          !terminalStatuses.has(completedSubscription.status)
        )
          throw new BillingConflictError(
            "Your subscription is being confirmed. Refresh your account shortly."
          )
      }
      if (session.status === "open") {
        if (row.checkout_price_id !== priceId)
          throw new BillingConflictError(
            "Finish your open checkout before selecting another billing interval."
          )
        return { url: safeStripeUrl(session.url, "checkout") }
      }
    }
    const pending = !row.checkout_session_id && row.checkout_started_at !== null
    if (pending && Date.now() - row.checkout_started_at! >= 23 * 60 * 60 * 1000)
      throw new BillingUnavailableError(
        "Checkout setup needs reconciliation. Please contact support."
      )
    if (pending && row.checkout_price_id !== priceId)
      throw new BillingConflictError(
        "Retry your original billing interval to finish setting up checkout."
      )
    const generation = pending
      ? row.checkout_generation
      : row.checkout_generation + 1
    const trialDays = pending
      ? row.checkout_trial_days
      : !row.trial_used &&
          !stripeTrialHistory &&
          config.trialDays &&
          !(await hasUsedManualTrial(env.DB, identity.userId))
        ? config.trialDays
        : null
    if (!pending)
      await updateBillingCustomer(env.DB, identity.userId, token, {
        checkout_session_id: null,
        checkout_expires_at: null,
        checkout_started_at: Date.now(),
        checkout_price_id: priceId,
        checkout_generation: generation,
        checkout_trial_days: trialDays,
      })
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        client_reference_id: identity.userId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${config.origin}/account?billing=success`,
        cancel_url: `${config.origin}/account?billing=canceled`,
        automatic_tax: { enabled: config.automaticTax },
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        allow_promotion_codes: true,
        payment_method_collection: "always",
        metadata: { photodepot_user_id: identity.userId },
        subscription_data: {
          billing_mode: { type: "flexible" },
          metadata: { photodepot_user_id: identity.userId },
          ...(trialDays
            ? {
                trial_period_days: trialDays,
                trial_settings: {
                  end_behavior: { missing_payment_method: "cancel" as const },
                },
              }
            : {}),
        },
      },
      {
        idempotencyKey: `photodepot-checkout-${row.customer_create_token}-${generation}`,
      }
    )
    if (
      session.livemode !== config.live ||
      objectId(session.customer) !== customerId
    )
      throw new BillingUnavailableError("Checkout mode mismatch.")
    await updateBillingCustomer(env.DB, identity.userId, token, {
      checkout_session_id: session.id,
      checkout_expires_at: session.expires_at * 1000,
    })
    return { url: safeStripeUrl(session.url, "checkout") }
  } finally {
    await unlockBillingAccount(env.DB, identity.userId, token)
  }
}

export async function createBillingPortal(
  env: Env,
  identity: BillingIdentity,
  deps: BillingDependencies = {}
) {
  const config = billingConfiguration(env, true)
  if (!config) throw new BillingUnavailableError("Billing is not configured.")
  if (!config.portalConfiguration)
    throw new BillingUnavailableError("Billing settings are not configured.")
  const { customer: row, token } = await lockBillingAccount(
    env.DB,
    identity.userId
  )
  try {
    if (!row.stripe_customer_id)
      throw new BillingConflictError(
        "Start a subscription before opening billing settings."
      )
    const stripe = deps.stripe ?? createBillingStripe(config)
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      configuration: config.portalConfiguration,
      return_url: `${config.origin}/account`,
    })
    return { url: safeStripeUrl(session.url, "portal") }
  } finally {
    await unlockBillingAccount(env.DB, identity.userId, token)
  }
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  )
    return value.id
  return null
}

function invoiceSubscription(invoice: Stripe.Invoice) {
  return objectId(invoice.parent?.subscription_details?.subscription)
}

/** Paid recurring lines, including positive upgrade prorations, prove a period. */
export function paidInvoiceEnd(
  invoice: Stripe.Invoice,
  subscriptionId: string,
  priceId: string,
  currentPeriodEnd: number
) {
  if (
    invoice.status !== "paid" ||
    invoiceSubscription(invoice) !== subscriptionId
  )
    return 0
  return invoice.lines.data.reduce((end, line) => {
    const details = line.parent?.subscription_item_details
    if (
      line.pricing?.price_details?.price !== priceId ||
      objectId(line.subscription) !== subscriptionId ||
      !details ||
      details.subscription !== subscriptionId ||
      line.quantity !== 1 ||
      !Number.isSafeInteger(line.amount) ||
      line.amount < 0 ||
      (details.proration && line.amount === 0) ||
      !Number.isSafeInteger(line.period.end) ||
      !Number.isSafeInteger(currentPeriodEnd) ||
      line.period.end <= line.period.start
    )
      return end
    return Math.max(end, Math.min(line.period.end, currentPeriodEnd) * 1000)
  }, 0)
}

const supportedEvents = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.finalization_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
])

/** Event data selects an account; fresh Stripe state determines its entitlement. */
export async function processBillingEvent(
  env: Env,
  event: Stripe.Event,
  deps: BillingDependencies = {}
) {
  const config = billingConfiguration(env, true)
  if (!config) throw new BillingUnavailableError("Billing is not configured.")
  if (event.livemode !== config.live || !supportedEvents.has(event.type)) return
  const object = event.data.object
  let customerId: string | null = null
  let subscriptionId: string | null = null
  let invoiceId: string | null = null
  if (object.object === "subscription") {
    customerId = objectId(object.customer)
    subscriptionId = object.id
  } else if (object.object === "invoice") {
    customerId = objectId(object.customer)
    subscriptionId = invoiceSubscription(object)
    invoiceId = object.id
  } else if (object.object === "checkout.session") {
    customerId = objectId(object.customer)
    subscriptionId = objectId(object.subscription)
  }
  if (!customerId || !subscriptionId) return
  const row = await env.DB.prepare(
    "SELECT * FROM stripe_customers WHERE stripe_customer_id = ?"
  )
    .bind(customerId)
    .first<BillingCustomer>()
  if (!row) return
  const { token } = await lockBillingAccount(env.DB, row.user_id)
  try {
    if (
      await env.DB.prepare("SELECT 1 FROM stripe_webhook_events WHERE id = ?")
        .bind(event.id)
        .first()
    )
      return
    const stripe = deps.stripe ?? createBillingStripe(config)
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice"],
    })
    const previous = await env.DB.prepare(
      "SELECT paid_through_at, price_id FROM stripe_subscriptions WHERE id = ? AND user_id = ?"
    )
      .bind(sub.id, row.user_id)
      .first<{ paid_through_at: number; price_id: string }>()
    const candidatePrice = sub.items.data[0]?.price.id
    const supported = !(
      sub.livemode !== config.live ||
      objectId(sub.customer) !== customerId ||
      sub.metadata.photodepot_user_id !== row.user_id ||
      sub.items.has_more ||
      sub.items.data.length !== 1 ||
      sub.items.data[0]?.quantity !== 1 ||
      !Object.values(config.prices).includes(candidatePrice) ||
      !subscriptionStatuses.has(sub.status)
    )
    // Ignore unrelated subscriptions. A tracked subscription that leaves the
    // configured catalog must stop authorizing access, including after a price
    // is removed from deployment configuration or an invalid portal change.
    if (!supported && !previous) return
    const priceId = supported ? candidatePrice! : previous!.price_id
    const status = supported
      ? sub.status
      : terminalStatuses.has(sub.status)
        ? sub.status
        : "unpaid"
    let paidThrough = 0
    const invoices: Stripe.Invoice[] = []
    if (
      supported &&
      typeof sub.latest_invoice === "object" &&
      sub.latest_invoice
    )
      invoices.push(sub.latest_invoice)
    else if (supported && typeof sub.latest_invoice === "string")
      invoices.push(await stripe.invoices.retrieve(sub.latest_invoice))
    if (
      supported &&
      invoiceId &&
      !invoices.some((invoice) => invoice.id === invoiceId)
    )
      invoices.push(await stripe.invoices.retrieve(invoiceId))
    for (const invoice of invoices) {
      if (
        invoice.livemode !== config.live ||
        objectId(invoice.customer) !== customerId ||
        invoice.status !== "paid" ||
        (sub.trial_start &&
          invoice.billing_reason === "subscription_create" &&
          invoice.total === 0)
      )
        continue
      if (invoice.lines.has_more) {
        const lines = await stripe.invoices.listLineItems(invoice.id, {
          limit: 100,
        })
        // This one-seat product never needs more than 100 invoice lines. Refuse
        // to acknowledge incomplete payment evidence and let the event retry.
        if (lines.has_more)
          throw new BillingUnavailableError("Invoice requires reconciliation.")
        invoice.lines = lines
      }
      paidThrough = Math.max(
        paidThrough,
        paidInvoiceEnd(
          invoice,
          sub.id,
          priceId,
          sub.items.data[0].current_period_end
        )
      )
    }
    const now = Date.now()
    const trialEnd =
      supported && sub.status === "trialing" && sub.trial_end
        ? sub.trial_end * 1000
        : null
    paidThrough = Math.max(previous?.paid_through_at ?? 0, paidThrough)
    const endsAt = Math.max(paidThrough, trialEnd ?? 0)
    // Conditional writes keep the entitlement and deduplication record in one
    // D1 transaction, and a missing receipt rejects a lost account lease.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stripe_webhook_events (id, type, created_at, processed_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM stripe_customers WHERE user_id = ? AND operation_token = ? AND operation_lease_until > ?)`
      ).bind(
        event.id,
        event.type,
        event.created * 1000,
        now,
        row.user_id,
        token,
        now
      ),
      env.DB.prepare(
        `INSERT INTO stripe_subscriptions (id, user_id, customer_id, status, price_id, starts_at, access_ends_at, paid_through_at, trial_ends_at, cancel_at_period_end, updated_at, revision)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(revision) FROM stripe_subscriptions WHERE user_id = ?), 0) + 1
        WHERE EXISTS (SELECT 1 FROM stripe_webhook_events WHERE id = ?) AND EXISTS (SELECT 1 FROM stripe_customers WHERE user_id = ? AND operation_token = ? AND operation_lease_until > ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, price_id = excluded.price_id,
        access_ends_at = excluded.access_ends_at, paid_through_at = excluded.paid_through_at, trial_ends_at = excluded.trial_ends_at,
        cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at, revision = excluded.revision`
      ).bind(
        sub.id,
        row.user_id,
        customerId,
        status,
        priceId,
        sub.start_date * 1000,
        endsAt,
        paidThrough,
        trialEnd,
        sub.cancel_at_period_end ? 1 : 0,
        now,
        row.user_id,
        event.id,
        row.user_id,
        token,
        now
      ),
      env.DB.prepare(
        `UPDATE stripe_customers SET trial_used = MAX(trial_used, ?)
        WHERE user_id = ? AND operation_token = ? AND operation_lease_until > ?`
      ).bind(sub.trial_start ? 1 : 0, row.user_id, token, now),
    ])
    const receipt = await env.DB.prepare(
      "SELECT 1 FROM stripe_webhook_events WHERE id = ?"
    )
      .bind(event.id)
      .first()
    if (!receipt)
      throw new BillingUnavailableError("Billing lease expired before update.")
  } finally {
    await unlockBillingAccount(env.DB, row.user_id, token)
  }
}
