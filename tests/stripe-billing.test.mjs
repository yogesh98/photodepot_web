import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, test } from "node:test"
import Stripe from "stripe"
import { sealData } from "iron-session"
import {
  billingConfiguration,
  billingSummary,
  createBillingCheckout,
  createBillingPortal,
  paidInvoiceEnd,
  processBillingEvent,
} from "../lib/stripe-billing.ts"
import {
  BillingConflictError,
  getBillingSubscription,
  lockBillingAccount,
  unlockBillingAccount,
} from "../lib/stripe-billing-store.ts"
import { handleBillingWebhook } from "../functions/api/billing/webhook.ts"
import { handleAccountBilling } from "../functions/api/account/billing.ts"

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
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_PRICE_MONTHLY: "price_monthly",
    STRIPE_PRICE_ANNUAL: "price_annual",
    STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture",
    WORKOS_API_KEY: "sk_workos",
    WORKOS_CLIENT_ID: "client_fixture",
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
function invoice(changes = {}) {
  return {
    object: "invoice",
    id: "in_fixture",
    livemode: false,
    customer: "cus_fixture",
    status: "paid",
    total: 1000,
    billing_reason: "subscription_cycle",
    parent: { subscription_details: { subscription: "sub_fixture" } },
    lines: {
      has_more: false,
      data: [
        {
          id: "il_fixture",
          subscription: "sub_fixture",
          quantity: 1,
          amount: 1000,
          pricing: { price_details: { price: "price_monthly" } },
          parent: {
            subscription_item_details: {
              subscription: "sub_fixture",
              proration: false,
            },
          },
          period: { start: now, end: monthEnd },
        },
      ],
    },
    ...changes,
  }
}
function subscription(changes = {}) {
  return {
    object: "subscription",
    id: "sub_fixture",
    customer: "cus_fixture",
    livemode: false,
    status: "active",
    metadata: { photodepot_user_id: identity.userId },
    start_date: now,
    cancel_at_period_end: false,
    trial_start: null,
    trial_end: null,
    items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          price: { id: "price_monthly" },
          current_period_end: monthEnd,
        },
      ],
    },
    latest_invoice: invoice(),
    ...changes,
  }
}
function event(
  id = "evt_fixture",
  type = "customer.subscription.updated",
  object = subscription()
) {
  return {
    id,
    object: "event",
    type,
    created: now,
    livemode: false,
    data: { object },
  }
}
function checkoutDeps() {
  const created = { customers: [], sessions: [], portals: [] }
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
          recurring: {
            interval: id === "price_monthly" ? "month" : "year",
            interval_count: 1,
          },
          tax_behavior: "exclusive",
          product: { active: true, tax_code: "txcd_fixture" },
        }
      },
    },
    checkout: {
      sessions: {
        async create(params, opts) {
          created.sessions.push({ params, opts })
          const session = {
            id: "cs_fixture",
            customer: "cus_fixture",
            livemode: false,
            status: "open",
            url: "https://checkout.stripe.com/c/pay/fixture",
            expires_at: now + 3600,
          }
          open.set(session.id, session)
          return session
        },
        async retrieve(id) {
          return open.get(id)
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          created.portals.push(params)
          return { url: "https://billing.stripe.com/p/session/fixture" }
        },
      },
    },
  }
  const organization = {
    id: "org_personal",
    externalId: `photodepot-billing:${identity.userId}`,
  }
  const workos = {
    organizations: {
      async getOrganizationByExternalId() {
        return organization
      },
      async updateOrganization() {},
    },
  }
  return { stripe, workos, created }
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

test("checkout uses fixed configured prices, tax, flexible billing and reusable idempotent sessions", async () => {
  const deps = checkoutDeps()
  const first = await createBillingCheckout(env, identity, "monthly", deps)
  assert.deepEqual(
    await createBillingCheckout(env, identity, "monthly", deps),
    first
  )
  assert.equal(deps.created.customers.length, 1)
  assert.equal(deps.created.sessions.length, 1)
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
  await assert.rejects(
    createBillingCheckout(env, identity, "annual", deps),
    BillingConflictError
  )
  assert.equal(
    sqlite.prepare("SELECT workos_organization_id FROM stripe_customers").get()
      .workos_organization_id,
    "org_personal"
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

test("a completed canceled subscription can be repurchased without another trial, even after a missed trial webhook", async () => {
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
  const summary = await billingSummary(env, identity.userId)
  assert.equal(summary.enabled, true)
  assert.deepEqual(summary.intervals, [])
  assert.equal(summary.portalEnabled, true)
  await createBillingPortal(env, identity, deps)
  assert.equal(deps.created.portals[0].customer, "cus_fixture")
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
    "always"
  )
  assert.equal(
    sqlite.prepare("SELECT trial_used FROM stripe_customers").get().trial_used,
    0
  )
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

test("paid matching lines grant access; unpaid renewed periods never extend previously paid time", async () => {
  customer()
  let canonical = subscription()
  let lookups = 0
  const deps = {
    stripe: {
      subscriptions: {
        async retrieve() {
          lookups++
          return canonical
        },
      },
    },
  }
  await processBillingEvent(env, event(), deps)
  assert.equal(
    (await getBillingSubscription(db, identity.userId)).endsAt,
    monthEnd * 1000
  )
  await processBillingEvent(env, event(), deps)
  assert.equal(lookups, 1)
  canonical = subscription({
    status: "past_due",
    latest_invoice: invoice({ status: "open" }),
    items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          price: { id: "price_monthly" },
          current_period_end: monthEnd + 30 * 86400,
        },
      ],
    },
  })
  await processBillingEvent(env, event("evt_failed"), deps)
  const result = await getBillingSubscription(db, identity.userId)
  assert.equal(result.status, "past_due")
  assert.equal(result.endsAt, monthEnd * 1000)
  assert.equal(result.revision, 2)
  canonical = subscription({ status: "canceled" })
  await processBillingEvent(
    env,
    event(
      "evt_out_of_order",
      "customer.subscription.updated",
      subscription({ status: "active" })
    ),
    deps
  )
  assert.equal(
    (await getBillingSubscription(db, identity.userId)).status,
    "canceled"
  )
})

test("a shortened trial and unpaid conversion cannot retain the earlier free-trial deadline", async () => {
  customer()
  const trialStart = now
  const initialInvoice = invoice({
    billing_reason: "subscription_create",
    total: 0,
    lines: {
      has_more: false,
      data: [{ ...invoice().lines.data[0], amount: 0 }],
    },
  })
  let canonical = subscription({
    status: "trialing",
    trial_start: trialStart,
    trial_end: monthEnd,
    latest_invoice: initialInvoice,
  })
  const deps = {
    stripe: {
      subscriptions: {
        async retrieve() {
          return canonical
        },
      },
      invoices: {
        async retrieve() {
          return initialInvoice
        },
      },
    },
  }
  await processBillingEvent(env, event("evt_trial"), deps)
  assert.equal(
    (await getBillingSubscription(db, identity.userId)).endsAt,
    monthEnd * 1000
  )
  assert.equal(
    sqlite.prepare("SELECT paid_through_at FROM stripe_subscriptions").get()
      .paid_through_at,
    0
  )
  canonical = { ...canonical, trial_end: now + 7 * 86400 }
  await processBillingEvent(env, event("evt_shorter"), deps)
  assert.equal(
    (await getBillingSubscription(db, identity.userId)).endsAt,
    (now + 7 * 86400) * 1000
  )
  canonical = {
    ...canonical,
    status: "active",
    latest_invoice: invoice({ id: "in_unpaid", status: "open" }),
  }
  await processBillingEvent(
    env,
    event("evt_delayed_trial_invoice", "invoice.paid", initialInvoice),
    deps
  )
  assert.equal((await getBillingSubscription(db, identity.userId)).endsAt, 0)
  assert.equal(
    sqlite.prepare("SELECT trial_used FROM stripe_customers").get().trial_used,
    1
  )
})

test("paid upgrade periods are accepted, while unrelated/credit lines are rejected and periods capped", () => {
  const paid = invoice()
  const line = paid.lines.data[0]
  line.parent.subscription_item_details.proration = true
  line.period.end = monthEnd + 365 * 86400
  assert.equal(
    paidInvoiceEnd(paid, "sub_fixture", "price_monthly", monthEnd),
    monthEnd * 1000
  )
  line.amount = -500
  assert.equal(
    paidInvoiceEnd(paid, "sub_fixture", "price_monthly", monthEnd),
    0
  )
  line.amount = 500
  line.quantity = 2
  assert.equal(
    paidInvoiceEnd(paid, "sub_fixture", "price_monthly", monthEnd),
    0
  )
})

test("tracked unsupported prices deny access while still reconciling cancellation", async () => {
  customer()
  let canonical = subscription()
  const deps = {
    stripe: {
      subscriptions: {
        async retrieve() {
          return canonical
        },
      },
    },
  }
  await processBillingEvent(env, event(), deps)
  canonical = subscription({
    items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          price: { id: "price_other" },
          current_period_end: monthEnd,
        },
      ],
    },
  })
  await processBillingEvent(env, event("evt_bad_catalog"), deps)
  assert.equal(
    (await getBillingSubscription(db, identity.userId)).status,
    "unpaid"
  )
  canonical.status = "canceled"
  await processBillingEvent(env, event("evt_cancel_bad_catalog"), deps)
  assert.equal(
    (await getBillingSubscription(db, identity.userId)).status,
    "canceled"
  )
})

test("account leases and transaction failures leave events retryable without partial receipts", async () => {
  customer()
  const deps = {
    stripe: {
      subscriptions: {
        async retrieve() {
          return subscription()
        },
      },
    },
  }
  const held = await lockBillingAccount(db, identity.userId)
  await assert.rejects(
    processBillingEvent(env, event(), deps),
    BillingConflictError
  )
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM stripe_webhook_events").get().n,
    0
  )
  await unlockBillingAccount(db, identity.userId, held.token)
  sqlite.exec(
    `CREATE TRIGGER fail_subscription BEFORE INSERT ON stripe_subscriptions BEGIN SELECT RAISE(ABORT,'retry storage'); END`
  )
  await assert.rejects(processBillingEvent(env, event(), deps), /retry storage/)
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM stripe_webhook_events").get().n,
    0
  )
  sqlite.exec("DROP TRIGGER fail_subscription")
  await processBillingEvent(env, event(), deps)
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM stripe_webhook_events").get().n,
    1
  )
})

test("raw-body signature verification supports events over 8KiB and rejects stale/tampered or oversized notifications", async () => {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY)
  const payload = JSON.stringify({
    ...event("evt_ignored", "product.updated", {
      object: "product",
      id: "prod_unused",
    }),
    padding: "x".repeat(10000),
  })
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET,
  })
  const request = (body, sig = signature) =>
    new Request("https://photodepot.app/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sig },
      body,
    })
  assert.equal((await handleBillingWebhook(request(payload), env)).status, 200)
  assert.equal(
    (await handleBillingWebhook(request(`${payload} `), env)).status,
    401
  )
  const old = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET,
    timestamp: now - 600,
  })
  assert.equal(
    (await handleBillingWebhook(request(payload, old), env)).status,
    401
  )
  assert.equal(
    (await handleBillingWebhook(request("x".repeat(262145)), env)).status,
    413
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
  globalThis.fetch = async (input) => {
    if (String(input).includes("/sso/jwks/"))
      return Response.json({ keys: [jwk] })
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
    assert.equal(unexpectedCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
