import Stripe from "stripe"
import { createWorkOS } from "@workos-inc/node"
import type { Env } from "./cloudflare.ts"
import {
  BillingConflictError,
  BillingUnavailableError,
  getBillingCustomer,
  hasUsedManualTrial,
  lockBillingAccount,
  unlockBillingAccount,
  updateBillingCustomer,
  type BillingCustomer,
} from "./stripe-billing-store.ts"
import {
  getWorkOSEntitlement,
  hasWorkOSBillingSession,
} from "./workos-entitlements.ts"

export type BillingInterval = "monthly" | "annual"
export interface BillingIdentity {
  userId: string
  email: string
}
interface BillingConfig {
  secret: string
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

/** Stripe state is display-only. WorkOS entitlements alone authorize paid access. */
export async function billingSummary(
  env: Env,
  userId: string,
  options: { forceRefresh?: boolean; stripe?: Stripe } = {}
) {
  const config = billingConfiguration(env, true)
  const disabled = {
    enabled: false,
    intervals: [] as BillingInterval[],
    subscription: null,
    hasCustomer: false,
    portalEnabled: false,
    trialDays: null,
    accessConnected: false,
    managedBy: "workos" as const,
  }
  if (!config) return disabled
  const customer = await getBillingCustomer(env.DB, userId)
  let connected = await hasWorkOSBillingSession(env.DB, userId)
  if (connected)
    await getWorkOSEntitlement(env, userId, {
      forceRefresh: options.forceRefresh,
    })
  connected = await hasWorkOSBillingSession(env.DB, userId)
  const stripe = options.stripe ?? createBillingStripe(config)
  const subscriptions = customer?.stripe_customer_id
    ? await stripe.subscriptions.list({
        customer: customer.stripe_customer_id,
        status: "all",
        limit: 100,
      })
    : null
  if (subscriptions?.has_more)
    throw new BillingUnavailableError("Billing history requires review.")
  const subscription =
    subscriptions?.data.find((sub) => !terminalStatuses.has(sub.status)) ??
    subscriptions?.data[0] ??
    null
  if (
    subscription &&
    (subscription.livemode !== config.live ||
      objectId(subscription.customer) !== customer!.stripe_customer_id)
  )
    throw new BillingUnavailableError("Billing customer mismatch.")
  const manualTrial = config.trialDays
    ? await hasUsedManualTrial(env.DB, userId)
    : false
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
          endsAt:
            (subscription.status === "trialing" && subscription.trial_end
              ? subscription.trial_end
              : Math.max(
                  0,
                  ...subscription.items.data.map(
                    (item) => item.current_period_end
                  )
                )) * 1000,
          cancelAtPeriodEnd: Boolean(
            subscription.cancel_at_period_end || subscription.cancel_at
          ),
        }
      : null,
    hasCustomer: Boolean(customer?.stripe_customer_id),
    portalEnabled: Boolean(config.portalConfiguration),
    trialDays:
      env.PHOTODEPOT_STRIPE_ENABLED !== "true" ||
      customer?.trial_used ||
      manualTrial ||
      subscriptions?.data.some((sub) => Boolean(sub.trial_start))
        ? null
        : config.trialDays,
    accessConnected: connected,
    managedBy: "workos" as const,
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
  // Entitlements are issued only for an active membership in this private org.
  const memberships = await workos.userManagement.listOrganizationMemberships({
    organizationId: organization.id,
    statuses: ["active", "inactive", "pending"],
    limit: 100,
  })
  if (
    memberships.listMetadata.after ||
    memberships.data.some((membership) => membership.userId !== identity.userId)
  )
    throw new BillingUnavailableError("Billing organization is not private.")
  const membership = memberships.data.find(
    (item) => item.userId === identity.userId
  )
  if (membership && membership.status !== "active")
    throw new BillingUnavailableError("Billing membership is unavailable.")
  if (!membership)
    await workos.userManagement.createOrganizationMembership({
      organizationId: organization.id,
      userId: identity.userId,
    })
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
    const { stripe, customerId } = await ensureCustomer(
      env,
      config,
      identity,
      row,
      token,
      deps
    )
    if (!(await hasWorkOSBillingSession(env.DB, identity.userId)))
      return {
        url: "/api/account/billing/authorize",
        provider: "workos" as const,
      }
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
        if (row.checkout_price_id === priceId)
          return {
            url: safeStripeUrl(session.url, "checkout"),
            provider: "stripe" as const,
          }
        // A cancel_url return leaves Checkout open. Close that session before
        // replacing its price so only one session can complete a purchase.
        const expired = await stripe.checkout.sessions.expire(session.id)
        if (
          expired.status !== "expired" ||
          expired.livemode !== config.live ||
          objectId(expired.customer) !== customerId
        )
          throw new BillingUnavailableError("Checkout could not be closed.")
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
    return {
      url: safeStripeUrl(session.url, "checkout"),
      provider: "stripe" as const,
    }
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
      return_url: `${config.origin}/account?billing=return`,
    })
    return {
      url: safeStripeUrl(session.url, "portal"),
      provider: "stripe" as const,
    }
  } finally {
    await unlockBillingAccount(env.DB, identity.userId, token)
  }
}

/** Reconnect the dedicated WorkOS grant without creating a paid subscription. */
export async function createBillingAccessConnection(
  env: Env,
  identity: BillingIdentity,
  deps: BillingDependencies = {}
) {
  const config = billingConfiguration(env, true)
  if (!config) throw new BillingUnavailableError("Billing is not configured.")
  const { customer, token } = await lockBillingAccount(env.DB, identity.userId)
  try {
    if (!customer.stripe_customer_id)
      throw new TypeError("Choose a subscription before connecting billing.")
    await ensureCustomer(env, config, identity, customer, token, deps)
    return {
      url: "/api/account/billing/authorize",
      provider: "workos" as const,
    }
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
