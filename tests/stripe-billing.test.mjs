import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, test } from "node:test"
import { sealData } from "iron-session"
import {
  billingConfiguration,
  billingSummary,
  createBillingAccessConnection,
  createBillingCheckout,
  createBillingPortal,
  createBillingSubscriptionFlow,
} from "../lib/stripe-billing.ts"
import { BillingConflictError } from "../lib/stripe-billing-store.ts"
import { handleAccountBilling } from "../functions/api/account/billing.ts"
import { workosBillingConfiguration } from "../lib/workos-entitlements.ts"

let sqlite, db, env
const now = Math.floor(Date.now() / 1000)
const monthEnd = now + 30 * 86400
const identity = {
  userId: "user_stripe_customer",
  email: "customer@example.test",
}

// Exercise the real SQLite migration/transaction behavior without external APIs.
function d1(database) {
  return {
    prepare(sql) {
      const prepared = database.prepare(sql)
      let values = []
      return {
        bind(...bound) {
          values = bound
          return this
        },
        async first() {
          return prepared.get(...values) ?? null
        },
        async all() {
          return { results: prepared.all(...values) }
        },
        async run() {
          const results = prepared.all(...values)
          return {
            results,
            meta: {
              changes: database.prepare("SELECT changes() AS n").get().n,
            },
          }
        },
      }
    },
    async batch(statements) {
      database.exec("BEGIN")
      try {
        const result = []
        for (const statement of statements) result.push(await statement.run())
        database.exec("COMMIT")
        return result
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
    },
  }
}

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys=ON")
  const directory = new URL("../migrations/", import.meta.url)
  for (const filename of (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(await readFile(new URL(filename, directory), "utf8"))
  db = d1(sqlite)
  env = {
    DB: db,
    PHOTODEPOT_STRIPE_ENABLED: "true",
    PHOTODEPOT_STRIPE_ORIGIN: "https://photodepot.app",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_PRICE_MONTHLY: "price_monthly",
    STRIPE_PRICE_ANNUAL: "price_annual",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture",
    WORKOS_API_KEY: "sk_workos",
    WORKOS_CLIENT_ID: "client_fixture",
    WORKOS_BILLING_CLIENT_ID: "client_billing_fixture",
    WORKOS_COOKIE_PASSWORD:
      "stripe-billing-test-password-at-least-32-characters",
  }
})
afterEach(() => sqlite.close())

function customer() {
  sqlite
    .prepare(
      `INSERT INTO stripe_customers(user_id,stripe_customer_id,customer_create_token) VALUES (?,?,?)`
    )
    .run(identity.userId, "cus_fixture", "fixture_token")
}
function subscription(changes = {}) {
  return {
    id: "sub_fixture",
    customer: "cus_fixture",
    livemode: false,
    status: "active",
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    items: {
      data: [
        {
          id: "si_fixture",
          current_period_end: monthEnd,
          quantity: 1,
          price: {
            id: "price_monthly",
            product: "prod_fixture",
            unit_amount: 2000,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    ...changes,
  }
}

function checkoutDeps({ connected = true } = {}) {
  if (connected) {
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO stripe_customers(user_id, customer_create_token) VALUES (?, 'fixture_token')"
      )
      .run(identity.userId)
    sqlite
      .prepare(
        "INSERT INTO workos_billing_sessions(user_id, session_id, encrypted_tokens, updated_at) VALUES (?, 'session_fixture', 'sealed_fixture', ?)"
      )
      .run(identity.userId, Date.now())
    sqlite
      .prepare(
        "INSERT INTO workos_entitlements(user_id,organization_id,context,enabled,issued_at,expires_at,revision) VALUES (?, 'org_personal', ?, 0, ?, ?, 1)"
      )
      .run(
        identity.userId,
        workosBillingConfiguration(env).context,
        Date.now(),
        Date.now() + 300_000
      )
  }
  const created = {
    customers: [],
    sessions: [],
    portals: [],
    expired: [],
    memberships: [],
  }
  const open = new Map()
  const stripe = {
    customers: {
      async create(params, opts) {
        created.customers.push({ params, opts })
        return { id: "cus_fixture", livemode: false }
      },
    },
    subscriptions: {
      async list() {
        return { data: [], has_more: false }
      },
    },
    prices: {
      async retrieve(id) {
        return {
          id,
          active: true,
          livemode: false,
          type: "recurring",
          unit_amount: id === "price_monthly" ? 2000 : 20000,
          currency: "usd",
          recurring: {
            interval: id === "price_monthly" ? "month" : "year",
            interval_count: 1,
          },
          tax_behavior: "exclusive",
          product: {
            id: "prod_fixture",
            active: true,
            tax_code: "txcd_fixture",
          },
        }
      },
    },
    checkout: {
      sessions: {
        async create(params, opts) {
          created.sessions.push({ params, opts })
          const session = {
            id: `cs_fixture_${created.sessions.length}`,
            customer: "cus_fixture",
            livemode: false,
            status: "open",
            allow_promotion_codes: params.allow_promotion_codes,
            payment_method_collection: params.payment_method_collection,
            url: "https://checkout.stripe.com/c/pay/fixture",
            expires_at: now + 3600,
          }
          open.set(session.id, session)
          return session
        },
        async retrieve(id) {
          return open.get(id)
        },
        async expire(id) {
          const session = open.get(id)
          assert.equal(session.status, "open")
          session.status = "expired"
          created.expired.push(id)
          return session
        },
      },
    },
    billingPortal: {
      configurations: {
        async retrieve() {
          return portalConfiguration()
        },
      },
      sessions: {
        async create(params) {
          created.portals.push(params)
          return {
            customer: params.customer,
            configuration: params.configuration,
            livemode: false,
            url: "https://billing.stripe.com/p/session/fixture",
          }
        },
      },
    },
  }
  const organization = {
    id: "org_personal",
    externalId: `photodepot-billing:${identity.userId}`,
  }
  const activeMemberships = []
  const workos = {
    userManagement: {
      async listOrganizationMemberships() {
        return { data: activeMemberships, listMetadata: {} }
      },
      async createOrganizationMembership(params) {
        created.memberships.push(params)
        const membership = { ...params, status: "active" }
        activeMemberships.push(membership)
        return membership
      },
    },
    organizations: {
      async getOrganizationByExternalId() {
        return organization
      },
      async updateOrganization() {},
    },
  }
  return { stripe, workos, created }
}

function portalConfiguration(changes = {}) {
  return {
    id: "bpc_fixture",
    active: true,
    livemode: false,
    features: {
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        products: [
          {
            product: "prod_fixture",
            prices: ["price_monthly", "price_annual"],
          },
        ],
      },
    },
    ...changes,
  }
}

test("billing requires an explicit purchase flag and matching test/live credentials", () => {
  assert.equal(billingConfiguration({}), null)
  assert.equal(
    billingConfiguration({ ...env, PHOTODEPOT_STRIPE_ENABLED: "false" }),
    null
  )
  assert.throws(() =>
    billingConfiguration({ ...env, STRIPE_SECRET_KEY: "sk_live_fixture" })
  )
  assert.throws(() =>
    billingConfiguration({
      ...env,
      PHOTODEPOT_STRIPE_ORIGIN: "https://evil.test/path",
    })
  )
  assert.throws(() =>
    billingConfiguration({ ...env, PHOTODEPOT_STRIPE_TRIAL_DAYS: "3.5" })
  )
  assert.equal(billingConfiguration(env).trialDays, null)
  assert.equal(
    billingConfiguration({ ...env, STRIPE_SECRET_KEY: "rk_test_fixture" }).live,
    false
  )
})

test("new purchases require a distinct billing client before creating provider resources", async () => {
  const deps = checkoutDeps({ connected: false })
  for (const value of [undefined, "", "invalid-client", env.WORKOS_CLIENT_ID]) {
    const invalid = { ...env, WORKOS_BILLING_CLIENT_ID: value }
    assert.throws(() => billingConfiguration(invalid), /not configured/)
    await assert.rejects(
      createBillingCheckout(invalid, identity, "monthly", deps),
      /not configured/
    )
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM stripe_customers").get().n,
      0
    )
    assert.deepEqual(deps.created.customers, [])
    assert.deepEqual(deps.created.memberships, [])
    assert.deepEqual(deps.created.sessions, [])
  }
})

test("legacy same-client sessions cannot skip separate billing authorization", async () => {
  const deps = checkoutDeps()
  sqlite
    .prepare("UPDATE workos_entitlements SET context=?")
    .run(JSON.stringify([env.WORKOS_CLIENT_ID, "photodepot-standard"]))
  const checkout = await createBillingCheckout(env, identity, "monthly", deps)
  assert.deepEqual(checkout, {
    url: "/api/account/billing/authorize?action=checkout&interval=monthly",
    provider: "workos",
  })
  assert.deepEqual(deps.created.sessions, [])
  const summary = await billingSummary(env, identity.userId, {
    stripe: deps.stripe,
  })
  assert.equal(summary.accessConnected, false)
  assert.equal(summary.accessUnavailable, false)
})

test("existing billing management survives missing billing client setup even with purchases enabled", async () => {
  const deps = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", deps)
  delete env.WORKOS_BILLING_CLIENT_ID
  deps.stripe.subscriptions.list = async () => ({
    data: [subscription()],
    has_more: false,
  })
  const summary = await billingSummary(env, identity.userId, {
    stripe: deps.stripe,
  })
  assert.equal(summary.accessConnected, false)
  assert.equal(summary.accessUnavailable, true)
  assert.equal(summary.portalEnabled, true)
  assert.deepEqual(summary.intervals, [])
  assert.equal(
    (await createBillingPortal(env, identity, deps)).provider,
    "stripe"
  )
  assert.equal(
    (await createBillingSubscriptionFlow(env, identity, "cancel", deps))
      .provider,
    "stripe"
  )
  await assert.rejects(
    createBillingCheckout(env, identity, "monthly", deps),
    /not configured/
  )
  env.PHOTODEPOT_STRIPE_ENABLED = "false"
  assert.equal(
    (await createBillingPortal(env, identity, deps)).provider,
    "stripe"
  )
})

test("checkout uses fixed configured prices, tax, flexible billing and reusable idempotent sessions", async () => {
  const deps = checkoutDeps()
  const first = await createBillingCheckout(env, identity, "monthly", deps)
  assert.deepEqual(
    await createBillingCheckout(env, identity, "monthly", deps),
    first
  )
  assert.equal(deps.created.customers.length, 1)
  assert.equal(deps.created.sessions.length, 1)
  assert.equal(deps.created.memberships.length, 1)
  const { params } = deps.created.sessions[0]
  assert.deepEqual(params.line_items, [{ price: "price_monthly", quantity: 1 }])
  assert.deepEqual(params.automatic_tax, { enabled: true })
  assert.deepEqual(params.tax_id_collection, { enabled: true })
  assert.deepEqual(params.customer_update, { name: "auto", address: "auto" })
  assert.deepEqual(params.subscription_data.billing_mode, { type: "flexible" })
  assert.equal(params.subscription_data.trial_period_days, undefined)
  assert.equal(
    params.success_url,
    "https://photodepot.app/account?billing=success"
  )
  assert.equal(params.allow_promotion_codes, true)
  assert.equal(params.payment_method_collection, "if_required")
  assert.equal(
    sqlite.prepare("SELECT workos_organization_id FROM stripe_customers").get()
      .workos_organization_id,
    "org_personal"
  )
})

test("an old Checkout requiring a card is replaced before applying the coupon-friendly policy", async () => {
  const deps = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", deps)
  const retrieve = deps.stripe.checkout.sessions.retrieve
  deps.stripe.checkout.sessions.retrieve = async (id) => ({
    ...(await retrieve(id)),
    payment_method_collection: "always",
  })
  await createBillingCheckout(env, identity, "monthly", deps)
  assert.equal(deps.created.expired.length, 1)
  assert.equal(deps.created.sessions.length, 2)
  assert.equal(
    deps.created.sessions[1].params.payment_method_collection,
    "if_required"
  )
  assert.equal(deps.created.sessions[1].params.allow_promotion_codes, true)
})

test("changing Checkout interval expires the abandoned session before creating its replacement", async () => {
  const deps = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", deps)
  const original = sqlite
    .prepare("SELECT checkout_session_id FROM stripe_customers")
    .get().checkout_session_id
  const create = deps.stripe.checkout.sessions.create
  deps.stripe.checkout.sessions.create = async (...args) => {
    assert.deepEqual(deps.created.expired, [original])
    return create(...args)
  }
  await createBillingCheckout(env, identity, "annual", deps)
  assert.equal(deps.created.sessions.length, 2)
  assert.deepEqual(deps.created.sessions[1].params.line_items, [
    { price: "price_annual", quantity: 1 },
  ])
  assert.notEqual(
    deps.created.sessions[0].opts.idempotencyKey,
    deps.created.sessions[1].opts.idempotencyKey
  )
  assert.notEqual(
    sqlite.prepare("SELECT checkout_session_id FROM stripe_customers").get()
      .checkout_session_id,
    original
  )
})

test("a Checkout expiration failure cannot create a second purchasable session", async () => {
  const deps = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", deps)
  deps.stripe.checkout.sessions.expire = async () => {
    throw new Error("Session completed before it could be expired")
  }
  await assert.rejects(
    createBillingCheckout(env, identity, "annual", deps),
    /Session completed before it could be expired/
  )
  assert.equal(deps.created.sessions.length, 1)
  assert.equal(
    sqlite.prepare("SELECT checkout_price_id FROM stripe_customers").get()
      .checkout_price_id,
    "price_monthly"
  )
  assert.equal(
    sqlite.prepare("SELECT operation_token FROM stripe_customers").get()
      .operation_token,
    null
  )
})

test("customer API side effects can retry after a persistence failure using the same key", async () => {
  const deps = checkoutDeps()
  sqlite.exec(
    `CREATE TRIGGER fail_customer_save BEFORE UPDATE OF stripe_customer_id ON stripe_customers BEGIN SELECT RAISE(ABORT,'temporary write failure'); END`
  )
  await assert.rejects(
    createBillingCheckout(env, identity, "monthly", deps),
    /temporary write failure/
  )
  sqlite.exec("DROP TRIGGER fail_customer_save")
  await createBillingCheckout(env, identity, "monthly", deps)
  assert.equal(deps.created.customers.length, 2)
  assert.equal(
    deps.created.customers[0].opts.idempotencyKey,
    deps.created.customers[1].opts.idempotencyKey
  )
})

test("a completed canceled subscription can be repurchased without another trial, using current Stripe history", async () => {
  env.PHOTODEPOT_STRIPE_TRIAL_DAYS = "7"
  const deps = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", deps)
  assert.equal(
    deps.created.sessions[0].params.subscription_data.trial_period_days,
    7
  )
  deps.stripe.subscriptions.list = async () => ({
    has_more: false,
    data: [{ id: "sub_old", status: "canceled", trial_start: now }],
  })
  deps.stripe.checkout.sessions.retrieve = async () => ({
    status: "complete",
    customer: "cus_fixture",
    livemode: false,
    subscription: "sub_old",
  })
  await createBillingCheckout(env, identity, "annual", deps)
  assert.equal(deps.created.sessions.length, 2)
  assert.equal(
    deps.created.sessions[1].params.subscription_data.trial_period_days,
    undefined
  )
  assert.notEqual(
    deps.created.sessions[0].opts.idempotencyKey,
    deps.created.sessions[1].opts.idempotencyKey
  )
  assert.equal(
    sqlite.prepare("SELECT trial_used FROM stripe_customers").get().trial_used,
    1
  )
})

test("existing subscriptions block a duplicate purchase; billing management survives disabled purchases", async () => {
  const deps = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", deps)
  deps.stripe.subscriptions.list = async () => ({
    data: [{ status: "past_due" }],
    has_more: false,
  })
  await assert.rejects(
    createBillingCheckout(env, identity, "monthly", deps),
    BillingConflictError
  )
  env.PHOTODEPOT_STRIPE_ENABLED = "false"
  await assert.rejects(
    createBillingCheckout(env, identity, "monthly", deps),
    /not enabled/
  )
  sqlite.prepare("DELETE FROM workos_billing_sessions").run()
  deps.stripe.subscriptions.list = async () => ({
    data: [subscription()],
    has_more: false,
  })
  const summary = await billingSummary(env, identity.userId, {
    stripe: deps.stripe,
  })
  assert.equal(summary.enabled, true)
  assert.deepEqual(summary.intervals, [])
  assert.equal(summary.portalEnabled, true)
  await createBillingPortal(env, identity, deps)
  assert.equal(deps.created.portals[0].customer, "cus_fixture")
})

test("cancel opens a hosted period-end confirmation for the server-mapped monthly or yearly subscription", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  for (const interval of ["monthly", "annual"]) {
    const current = subscription()
    current.items.data[0].price.id = `price_${interval}`
    current.items.data[0].price.recurring.interval =
      interval === "monthly" ? "month" : "year"
    deps.stripe.subscriptions.list = async (params) => {
      assert.deepEqual(params, {
        customer: "cus_fixture",
        status: "all",
        limit: 100,
      })
      return { data: [current], has_more: false }
    }
    const result = await createBillingSubscriptionFlow(
      env,
      identity,
      "cancel",
      deps
    )
    assert.equal(result.url, "https://billing.stripe.com/p/session/fixture")
    assert.equal(result.provider, "stripe")
    assert.deepEqual(deps.created.portals.at(-1), {
      customer: "cus_fixture",
      configuration: "bpc_fixture",
      return_url: "https://photodepot.app/account?billing=return",
      flow_data: {
        type: "subscription_cancel",
        subscription_cancel: { subscription: "sub_fixture" },
        after_completion: {
          type: "redirect",
          redirect: {
            return_url: "https://photodepot.app/account?billing=return",
          },
        },
      },
    })
    assert.equal(current.cancel_at_period_end, false)
    assert.equal(current.status, "active")
  }
  assert.equal(deps.created.sessions.length, 0)
  assert.equal(deps.created.customers.length, 0)
  assert.equal(deps.created.memberships.length, 0)
})

test("yearly upgrade targets the existing monthly item and requires hosted Stripe confirmation", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  const current = subscription({ discounts: ["di_existing"] })
  deps.stripe.subscriptions.list = async () => ({
    data: [current],
    has_more: false,
  })
  await createBillingSubscriptionFlow(env, identity, "upgrade", deps)
  assert.deepEqual(deps.created.portals[0].flow_data, {
    type: "subscription_update_confirm",
    subscription_update_confirm: {
      subscription: "sub_fixture",
      items: [{ id: "si_fixture", price: "price_annual", quantity: 1 }],
    },
    after_completion: {
      type: "redirect",
      redirect: { return_url: "https://photodepot.app/account?billing=return" },
    },
  })
  assert.equal(current.items.data[0].price.id, "price_monthly")
  assert.deepEqual(current.discounts, ["di_existing"])
  assert.equal(deps.created.sessions.length, 0)
})

test("a subscription on a retired price can still cancel while upgrades remain restricted", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  const current = subscription()
  current.items.data[0].price.id = "price_retired"
  deps.stripe.subscriptions.list = async () => ({
    data: [current],
    has_more: false,
  })
  await createBillingSubscriptionFlow(env, identity, "cancel", deps)
  assert.equal(deps.created.portals.length, 1)
  assert.deepEqual(deps.created.portals[0].flow_data.subscription_cancel, {
    subscription: current.id,
  })
  await assert.rejects(
    createBillingSubscriptionFlow(env, identity, "upgrade", deps),
    /needs review in billing settings/
  )
  assert.equal(deps.created.portals.length, 1)
  assert.equal(current.cancel_at_period_end, false)
})

test("targeted subscription flows reject ambiguous, foreign, terminal and unsupported subscriptions", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  const item = subscription().items.data[0]
  for (const response of [
    { data: [], has_more: false },
    { data: [subscription({ status: "canceled" })], has_more: false },
    { data: [subscription()], has_more: true },
    {
      data: [subscription(), subscription({ id: "sub_second" })],
      has_more: false,
    },
    { data: [subscription({ customer: "cus_other" })], has_more: false },
    { data: [subscription({ livemode: true })], has_more: false },
    {
      data: [
        subscription({ items: { data: [item, { ...item, id: "si_second" }] } }),
      ],
      has_more: false,
    },
    {
      data: [subscription({ items: { data: [item], has_more: true } })],
      has_more: false,
    },
    {
      data: [subscription({ items: { data: [{ ...item, quantity: 2 }] } })],
      has_more: false,
    },
    { data: [subscription({ cancel_at_period_end: true })], has_more: false },
  ]) {
    deps.stripe.subscriptions.list = async () => response
    for (const action of ["cancel", "upgrade"])
      await assert.rejects(
        createBillingSubscriptionFlow(env, identity, action, deps)
      )
    assert.equal(
      sqlite.prepare("SELECT operation_token FROM stripe_customers").get()
        .operation_token,
      null
    )
  }
  assert.equal(deps.created.portals.length, 0)
})

test("yearly confirmation rejects existing yearly, unsettled and scheduled changes", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  const item = subscription().items.data[0]
  for (const current of [
    subscription({
      items: {
        data: [
          {
            ...item,
            price: {
              ...item.price,
              id: "price_annual",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }),
    subscription({ status: "past_due" }),
    subscription({ pending_update: { expires_at: now + 3600 } }),
    subscription({ schedule: "sub_sched_fixture" }),
  ]) {
    deps.stripe.subscriptions.list = async () => ({
      data: [current],
      has_more: false,
    })
    await assert.rejects(
      createBillingSubscriptionFlow(env, identity, "upgrade", deps),
      /current monthly/
    )
  }
  assert.equal(deps.created.portals.length, 0)
})

test("targeted flows require a matching Portal configuration and permitted same-product annual price", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  deps.stripe.subscriptions.list = async () => ({
    data: [subscription()],
    has_more: false,
  })
  for (const configuration of [
    portalConfiguration({ active: false }),
    portalConfiguration({ livemode: true }),
    portalConfiguration({ id: "bpc_other" }),
    portalConfiguration({
      features: {
        subscription_cancel: { enabled: false, mode: "at_period_end" },
      },
    }),
    portalConfiguration({
      features: { subscription_cancel: { enabled: true, mode: "immediately" } },
    }),
  ]) {
    deps.stripe.billingPortal.configurations.retrieve = async () =>
      configuration
    await assert.rejects(
      createBillingSubscriptionFlow(env, identity, "cancel", deps)
    )
  }
  for (const updates of [
    { enabled: false, default_allowed_updates: ["price"], products: [] },
    { enabled: true, default_allowed_updates: ["quantity"], products: [] },
    {
      enabled: true,
      default_allowed_updates: ["price"],
      products: [{ product: "prod_fixture", prices: ["price_monthly"] }],
    },
  ]) {
    const configuration = portalConfiguration()
    configuration.features.subscription_update = updates
    deps.stripe.billingPortal.configurations.retrieve = async () =>
      configuration
    await assert.rejects(
      createBillingSubscriptionFlow(env, identity, "upgrade", deps),
      /Yearly plan settings/
    )
  }
  deps.stripe.billingPortal.configurations.retrieve = async () =>
    portalConfiguration()
  const retrieve = deps.stripe.prices.retrieve
  for (const change of [
    { product: { id: "prod_other", active: true, tax_code: "txcd_fixture" } },
    { currency: "eur" },
  ]) {
    deps.stripe.prices.retrieve = async (id) => ({
      ...(await retrieve(id)),
      ...change,
    })
    await assert.rejects(
      createBillingSubscriptionFlow(env, identity, "upgrade", deps),
      /Yearly plan settings/
    )
  }
  assert.equal(deps.created.portals.length, 0)
})

test("cancellation remains available with purchases disabled while upgrades are blocked", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  deps.stripe.subscriptions.list = async () => ({
    data: [subscription()],
    has_more: false,
  })
  env.PHOTODEPOT_STRIPE_ENABLED = "false"
  await createBillingSubscriptionFlow(env, identity, "cancel", deps)
  await assert.rejects(
    createBillingSubscriptionFlow(env, identity, "upgrade", deps),
    /not enabled/
  )
  assert.equal(deps.created.portals.length, 1)
})

test("a targeted flow holds the billing lease until its hosted session is created", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  let release, reached
  const entered = new Promise((resolve) => {
    reached = resolve
  })
  deps.stripe.subscriptions.list = async () => {
    reached()
    await new Promise((resolve) => {
      release = resolve
    })
    return { data: [subscription()], has_more: false }
  }
  const first = createBillingSubscriptionFlow(env, identity, "cancel", deps)
  await entered
  await assert.rejects(
    createBillingSubscriptionFlow(env, identity, "cancel", deps),
    BillingConflictError
  )
  release()
  await first
  assert.equal(deps.created.portals.length, 1)
})

test("targeted flows reject mismatched session customers, modes, configurations and unsafe URLs", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  deps.stripe.subscriptions.list = async () => ({
    data: [subscription()],
    has_more: false,
  })
  for (const change of [
    { customer: "cus_other" },
    { livemode: true },
    { configuration: "bpc_other" },
    { url: "https://attacker.test/billing" },
    { url: "https://billing.stripe.com:8443/portal" },
  ]) {
    deps.stripe.billingPortal.sessions.create = async () => ({
      customer: "cus_fixture",
      configuration: "bpc_fixture",
      livemode: false,
      url: "https://billing.stripe.com/p/session/fixture",
      ...change,
    })
    await assert.rejects(
      createBillingSubscriptionFlow(env, identity, "cancel", deps)
    )
  }
})

test("trials require explicit days, are reused on retry, and prior manual trial history prevents a second trial", async () => {
  env.PHOTODEPOT_STRIPE_TRIAL_DAYS = "7"
  const deps = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", deps)
  assert.equal(
    deps.created.sessions[0].params.subscription_data.trial_period_days,
    7
  )
  assert.equal(
    deps.created.sessions[0].params.payment_method_collection,
    "if_required"
  )
  assert.equal(
    sqlite.prepare("SELECT trial_used FROM stripe_customers").get().trial_used,
    0
  )
  sqlite.prepare("DELETE FROM workos_billing_sessions").run()
  sqlite.prepare("DELETE FROM workos_entitlements").run()
  sqlite.prepare("DELETE FROM stripe_customers").run()
  sqlite
    .prepare(
      `INSERT INTO subscriptions(id,user_id,type,status,started_at,end_at,updated_at,revision) VALUES(?,?,'regular','active',1,10000,1,1)`
    )
    .run("manual_trial", identity.userId)
  sqlite
    .prepare(
      `INSERT INTO subscription_audit(id,subscription_id,action,actor,created_at,detail) VALUES('history','manual_trial','set','Owner',1,'Set trial access until earlier')`
    )
    .run()
  const second = checkoutDeps()
  await createBillingCheckout(env, identity, "monthly", second)
  assert.equal(
    second.created.sessions[0].params.subscription_data.trial_period_days,
    undefined
  )
})

test("account billing uses the authenticated identity and rejects foreign origins and client-chosen prices or accounts", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = {
    ...rsa.publicKey.export({ format: "jwk" }),
    kid: "billing-account-key",
    use: "sig",
    alg: "RS256",
  }
  const password = "billing-account-fixture-password-at-least-32-characters"
  env.WORKOS_CLIENT_ID = "client_billing_api"
  env.WORKOS_COOKIE_PASSWORD = password
  env.WORKOS_REDIRECT_URI = "https://photodepot.app/api/auth/callback"
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: env.WORKOS_CLIENT_ID,
      sub: identity.userId,
      sid: "session_billing",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  ).toString("base64url")
  const accessToken = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
  const sealed = await sealData(
    {
      version: 1,
      audience: "account",
      clientId: env.WORKOS_CLIENT_ID,
      origin: "https://photodepot.app",
      accessToken,
      refreshToken: "fixture",
      user: { id: identity.userId, email: identity.email, emailVerified: true },
    },
    { password, ttl: 604800 }
  )
  const originalFetch = globalThis.fetch
  let unexpectedCalls = 0
  const flowCalls = []
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/sso/jwks/"))
      return Response.json({ keys: [jwk] })
    const url = new URL(String(input))
    if (
      url.hostname === "api.stripe.com" &&
      /^\/v1\/prices\/price_(monthly|annual)$/.test(url.pathname)
    ) {
      const id = url.pathname.split("/").at(-1)
      return Response.json({
        id,
        active: true,
        livemode: false,
        type: "recurring",
        unit_amount: id === "price_monthly" ? 2000 : 20000,
        currency: "usd",
        recurring: {
          interval: id === "price_monthly" ? "month" : "year",
          interval_count: 1,
        },
        tax_behavior: "exclusive",
        product: { id: "prod_fixture", active: true, tax_code: "txcd_fixture" },
      })
    }
    if (
      url.hostname === "api.stripe.com" &&
      url.pathname === "/v1/subscriptions"
    ) {
      assert.equal(url.searchParams.get("customer"), "cus_fixture")
      return Response.json({ data: [subscription()], has_more: false })
    }
    if (
      url.hostname === "api.stripe.com" &&
      url.pathname === "/v1/billing_portal/configurations/bpc_fixture"
    )
      return Response.json(portalConfiguration())
    if (
      url.hostname === "api.stripe.com" &&
      url.pathname === "/v1/billing_portal/sessions"
    ) {
      assert.equal(init.method, "POST")
      flowCalls.push(new URLSearchParams(init.body))
      return Response.json({
        customer: "cus_fixture",
        configuration: "bpc_fixture",
        livemode: false,
        url: "https://billing.stripe.com/p/session/fixture",
      })
    }
    unexpectedCalls++
    throw new Error("Unexpected external API call")
  }
  const request = (body, changes = {}) =>
    new Request("https://photodepot.app/api/account/billing", {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://photodepot.app",
        cookie: `__Host-photodepot-account=${sealed}`,
        "content-type": "application/json",
        ...changes,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  try {
    assert.equal(
      (await handleAccountBilling(request(null, { cookie: "" }), env)).status,
      401
    )
    const summary = await handleAccountBilling(request(), env)
    assert.equal(summary.status, 200)
    assert.equal((await summary.json()).hasCustomer, false)
    assert.equal(
      (
        await handleAccountBilling(
          request({ action: "portal" }, { origin: "https://evil.test" }),
          env
        )
      ).status,
      403
    )
    assert.equal(
      (
        await handleAccountBilling(
          request({
            action: "checkout",
            interval: "monthly",
            userId: "user_other",
          }),
          env
        )
      ).status,
      400
    )
    assert.equal(
      (
        await handleAccountBilling(
          request({
            action: "checkout",
            interval: "monthly",
            price: "price_evil",
          }),
          env
        )
      ).status,
      400
    )
    assert.equal(
      (
        await handleAccountBilling(
          request({ action: "portal", return_url: "https://evil.test" }),
          env
        )
      ).status,
      400
    )
    for (const body of [
      { action: "cancel", userId: "user_other" },
      { action: "cancel", subscription: "sub_other" },
      { action: "cancel", return_url: "https://evil.test" },
      { action: "cancel", interval: "monthly" },
      { action: "upgrade" },
      { action: "upgrade", interval: "monthly" },
      { action: "upgrade", interval: "annual", price: "price_evil" },
      { action: "upgrade", interval: "annual", customer: "cus_other" },
    ])
      assert.equal((await handleAccountBilling(request(body), env)).status, 400)
    for (const action of ["cancel", "upgrade"])
      assert.equal(
        (
          await handleAccountBilling(
            request(
              {
                action,
                ...(action === "upgrade" ? { interval: "annual" } : {}),
              },
              { origin: "https://evil.test" }
            ),
            env
          )
        ).status,
        403
      )
    assert.equal(unexpectedCalls, 0)
    assert.equal(flowCalls.length, 0)
    customer()
    for (const body of [
      { action: "cancel" },
      { action: "upgrade", interval: "annual" },
    ]) {
      const response = await handleAccountBilling(request(body), env)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), {
        provider: "stripe",
        url: "https://billing.stripe.com/p/session/fixture",
      })
    }
    assert.equal(flowCalls.length, 2)
    assert.equal(flowCalls[0].get("flow_data[type]"), "subscription_cancel")
    assert.equal(
      flowCalls[0].get("flow_data[subscription_cancel][subscription]"),
      "sub_fixture"
    )
    assert.equal(
      flowCalls[1].get("flow_data[type]"),
      "subscription_update_confirm"
    )
    assert.equal(
      flowCalls[1].get(
        "flow_data[subscription_update_confirm][items][0][price]"
      ),
      "price_annual"
    )
    assert.equal(
      flowCalls[1].get(
        "flow_data[subscription_update_confirm][items][0][quantity]"
      ),
      "1"
    )
    assert.equal(unexpectedCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Checkout prepares a private WorkOS membership then requires separate billing authorization", async () => {
  const deps = checkoutDeps({ connected: false })
  const result = await createBillingCheckout(env, identity, "monthly", deps)
  assert.deepEqual(result, {
    url: "/api/account/billing/authorize?action=checkout&interval=monthly",
    provider: "workos",
  })
  assert.deepEqual(deps.created.memberships, [
    { organizationId: "org_personal", userId: identity.userId },
  ])
  assert.equal(deps.created.sessions.length, 0)
})

test("billing uses live Stripe state only for display, including flexible cancellation", async () => {
  customer()
  const { stripe } = checkoutDeps({ connected: false })
  stripe.subscriptions.list = async () => ({
    data: [subscription({ cancel_at: monthEnd, canceled_at: now })],
    has_more: false,
  })
  const result = await billingSummary(env, identity.userId, { stripe })
  assert.equal(result.managedBy, "workos")
  assert.equal(result.accessConnected, false)
  assert.equal(result.subscription.cancelAtPeriodEnd, true)
  assert.equal(result.subscription.endsAt, monthEnd * 1000)
  assert.deepEqual(result.prices, {
    monthly: { amount: 2000, currency: "usd" },
    annual: { amount: 20000, currency: "usd" },
  })
  assert.equal(result.subscription.interval, "monthly")
  assert.equal(result.subscription.amount, 2000)
  assert.equal(result.subscription.currency, "usd")
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM stripe_subscriptions").get().n,
    0
  )
})

test("annual pricing and existing discounts come from Stripe rather than a client supplied price", async () => {
  customer()
  const { stripe } = checkoutDeps({ connected: false })
  stripe.subscriptions.list = async () => ({
    data: [
      subscription({
        discounts: ["di_free"],
        items: {
          data: [
            {
              current_period_end: monthEnd,
              quantity: 1,
              price: {
                unit_amount: 20000,
                currency: "usd",
                recurring: { interval: "year", interval_count: 1 },
              },
            },
          ],
        },
      }),
    ],
    has_more: false,
  })
  const summary = await billingSummary(env, identity.userId, { stripe })
  assert.equal(summary.subscription.interval, "annual")
  assert.equal(summary.subscription.amount, 20000)
  assert.equal(summary.subscription.discountsApplied, true)
  assert.equal(summary.prices.annual.amount, summary.prices.monthly.amount * 10)
  delete env.STRIPE_PRICE_ANNUAL
  const monthlyOnly = await billingSummary(env, identity.userId, { stripe })
  assert.deepEqual(monthlyOnly.intervals, ["monthly"])
  assert.equal(monthlyOnly.prices.annual, undefined)
})

test("invalid or mismatched configured prices cannot be advertised or purchased", async () => {
  const deps = checkoutDeps({ connected: false })
  const retrieve = deps.stripe.prices.retrieve
  for (const invalid of [
    { unit_amount: null },
    { unit_amount: -1 },
    { livemode: true },
    { recurring: { interval: "week", interval_count: 1 } },
  ]) {
    deps.stripe.prices.retrieve = async (id) => ({
      ...(await retrieve(id)),
      ...invalid,
    })
    await assert.rejects(
      billingSummary(env, identity.userId, { stripe: deps.stripe }),
      /price needs review/
    )
  }
})

test("terminal subscriptions display their actual end, never the original future billing period", async () => {
  customer()
  const { stripe } = checkoutDeps({ connected: false })
  for (const status of ["canceled", "incomplete_expired"]) {
    for (const [timestamps, expectedEnd] of [
      [{ ended_at: now, canceled_at: now - 60 }, now],
      [{ ended_at: null, canceled_at: now - 60 }, now - 60],
      [{}, 0],
    ]) {
      stripe.subscriptions.list = async () => ({
        data: [subscription({ status, ...timestamps })],
        has_more: false,
      })
      const result = await billingSummary(env, identity.userId, { stripe })
      assert.equal(result.subscription.status, status)
      assert.equal(result.subscription.endsAt, expectedEnd * 1000)
    }
  }
})

test("reconnecting access validates the private membership without making a Checkout", async () => {
  customer()
  const deps = checkoutDeps({ connected: false })
  const result = await createBillingAccessConnection(env, identity, deps)
  assert.deepEqual(result, {
    url: "/api/account/billing/authorize",
    provider: "workos",
  })
  assert.equal(deps.created.memberships.length, 1)
  assert.equal(deps.created.sessions.length, 0)
  assert.equal(deps.created.customers.length, 0)
})

test("billing cannot add another user or reactivate a disabled personal membership", async () => {
  const deps = checkoutDeps()
  deps.workos.userManagement.listOrganizationMemberships = async () => ({
    data: [{ userId: "user_other", status: "active" }],
    listMetadata: {},
  })
  await assert.rejects(
    createBillingCheckout(env, identity, "monthly", deps),
    /not private/
  )
  deps.workos.userManagement.listOrganizationMemberships = async () => ({
    data: [{ userId: identity.userId, status: "inactive" }],
    listMetadata: {},
  })
  await assert.rejects(
    createBillingCheckout(env, identity, "monthly", deps),
    /membership is unavailable/
  )
  assert.equal(deps.created.memberships.length, 0)
  assert.equal(deps.created.sessions.length, 0)
})
