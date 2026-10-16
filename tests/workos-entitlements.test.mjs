import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, test } from "node:test"
import { sealData, unsealData } from "iron-session"
import {
  getWorkOSEntitlement,
  hasWorkOSBillingSession,
  storeWorkOSBillingSession,
} from "../lib/workos-entitlements.ts"
import { handleWorkOSBillingAuthorize } from "../lib/workos-billing-auth.ts"
import { billingSummary } from "../lib/stripe-billing.ts"
import {
  handleAdminCallback,
  authenticateWorkOSAccount,
  verifyWorkOSAccessToken,
} from "../lib/license-admin-auth.ts"
import { handleAccountSubscription } from "../functions/api/account/subscription.ts"
import { handleAccountBilling } from "../functions/api/account/billing.ts"
import { getAccountEntitlement } from "../lib/account-entitlement.ts"

const origin = "https://photodepot.app"
const clientId = "client_workos_entitlements_tests"
const password = "workos-billing-tests-password-at-least-32-characters"
const userId = "user_billing_entitlements"
const organizationId = "org_billing_personal"
const backendSid = "session_billing_backend"
const browserSid = "session_account_browser"
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "entitlements-key",
  alg: "RS256",
  use: "sig",
}
let sqlite,
  env,
  epoch,
  originalFetch,
  authenticationCalls,
  tokenResponse,
  authenticationFailure,
  organizationResponse,
  checkoutCalls,
  checkoutSession,
  subscriptionResponse

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
function jwt(changes = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: userId,
      sid: backendSid,
      org_id: organizationId,
      iat: Math.floor(epoch / 1000),
      exp: Math.floor(epoch / 1000) + 300,
      entitlements: ["photodepot-standard"],
      ...changes,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}
function authentication(
  accessToken = jwt(),
  refreshToken = "refresh_backend_rotated"
) {
  return {
    user: {
      object: "user",
      id: userId,
      email: "billing@example.test",
      email_verified: true,
      first_name: "Billing",
      last_name: "Tester",
      profile_picture_url: null,
      created_at: new Date(epoch).toISOString(),
      updated_at: new Date(epoch).toISOString(),
    },
    access_token: accessToken,
    refresh_token: refreshToken,
    organization_id: organizationId,
  }
}
async function store(
  accessToken = jwt(),
  refreshToken = "refresh_backend_initial"
) {
  return storeWorkOSBillingSession(env, {
    userId,
    organizationId,
    browserSessionId: browserSid,
    accessToken,
    refreshToken,
  })
}
async function storedTokens() {
  const row = sqlite
    .prepare(
      "SELECT encrypted_tokens FROM workos_billing_sessions WHERE user_id = ?"
    )
    .get(userId)
  return row ? unsealData(row.encrypted_tokens, { password, ttl: 0 }) : null
}
async function browserCookie() {
  return `__Host-photodepot-account=${await sealData(
    {
      version: 1,
      audience: "account",
      clientId,
      origin,
      accessToken: jwt({
        sid: browserSid,
        org_id: undefined,
        entitlements: undefined,
      }),
      refreshToken: "refresh_browser_never_copy",
      user: { id: userId, email: "billing@example.test", emailVerified: true },
    },
    { password, ttl: 604800 }
  )}`
}
function request(path, cookie) {
  return new Request(`${origin}${path}`, { headers: cookie ? { cookie } : {} })
}
async function authorize(query = "") {
  const accountCookie = await browserCookie()
  const start = await handleWorkOSBillingAuthorize(
    request(`/api/account/billing/authorize${query}`, accountCookie),
    env
  )
  assert.equal(start.status, 303)
  const location = new URL(start.headers.get("location"))
  assert.equal(location.searchParams.get("organization_id"), organizationId)
  // A silent AuthKit grant can reuse the browser SID and its rotating tokens.
  assert.equal(location.searchParams.get("max_age"), "0")
  const transactionCookie = start.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-photodepot-billing-auth="))
    .split(";")[0]
  return {
    accountCookie,
    transactionCookie,
    state: location.searchParams.get("state"),
  }
}

beforeEach(async () => {
  epoch = Date.now()
  sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys=ON")
  const directory = new URL("../migrations/", import.meta.url)
  for (const filename of (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(await readFile(new URL(filename, directory), "utf8"))
  env = {
    DB: d1(sqlite),
    WORKOS_CLIENT_ID: clientId,
    WORKOS_API_KEY: "sk_workos_fixture",
    WORKOS_ADMIN_ORGANIZATION_ID: "org_administration",
    WORKOS_COOKIE_PASSWORD: password,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
  }
  sqlite
    .prepare(
      "INSERT INTO stripe_customers(user_id,stripe_customer_id,workos_organization_id,customer_create_token) VALUES (?,?,?,?)"
    )
    .run(userId, "cus_billing", organizationId, "token_fixture")
  authenticationCalls = []
  checkoutCalls = []
  checkoutSession = {
    id: "cs_billing_fixture",
    customer: "cus_billing",
    livemode: false,
    status: "open",
    allow_promotion_codes: true,
    payment_method_collection: "if_required",
    url: "https://checkout.stripe.com/c/pay/billing_fixture",
    expires_at: Math.floor(epoch / 1000) + 3600,
  }
  subscriptionResponse = { object: "list", data: [], has_more: false }
  tokenResponse = authentication()
  authenticationFailure = null
  organizationResponse = {
    object: "organization",
    id: organizationId,
    name: "Personal billing",
    domains: [],
    external_id: `photodepot-billing:${userId}`,
    stripe_customer_id: "cus_billing",
    metadata: {},
    created_at: new Date(epoch).toISOString(),
    updated_at: new Date(epoch).toISOString(),
  }
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const parsed = new URL(url)
    if (url === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    if (url === `https://api.workos.com/organizations/${organizationId}`)
      return Response.json(organizationResponse)
    if (
      parsed.hostname === "api.workos.com" &&
      decodeURIComponent(parsed.pathname) ===
        `/organizations/external_id/photodepot-billing:${userId}`
    )
      return Response.json(organizationResponse)
    if (parsed.pathname === "/user_management/organization_memberships")
      return Response.json({
        object: "list",
        data: [
          {
            object: "organization_membership",
            id: "om_fixture",
            user_id: userId,
            organization_id: organizationId,
            status: "active",
            role: { slug: "member" },
            created_at: new Date(epoch).toISOString(),
            updated_at: new Date(epoch).toISOString(),
          },
        ],
        list_metadata: { before: null, after: null },
      })
    if (parsed.hostname === "api.stripe.com") {
      assert.equal(await hasWorkOSBillingSession(env.DB, userId), true)
      if (parsed.pathname === "/v1/subscriptions")
        return Response.json(subscriptionResponse)
      if (parsed.pathname.startsWith("/v1/prices/")) {
        const id = parsed.pathname.split("/").at(-1)
        return Response.json({
          id,
          active: true,
          livemode: false,
          type: "recurring",
          unit_amount: 2000,
          currency: "usd",
          recurring: {
            interval: id === "price_monthly" ? "month" : "year",
            interval_count: 1,
          },
          tax_behavior: "exclusive",
          product: {
            id: "prod_billing",
            active: true,
            tax_code: "txcd_fixture",
          },
        })
      }
      if (parsed.pathname === "/v1/checkout/sessions") {
        assert.equal(init.method, "POST")
        checkoutCalls.push({
          params: new URLSearchParams(init.body),
          headers: new Headers(init.headers),
        })
        return Response.json(checkoutSession)
      }
      if (parsed.pathname === `/v1/checkout/sessions/${checkoutSession.id}`)
        return Response.json(checkoutSession)
      assert.fail(`Unexpected Stripe request: ${parsed.pathname}`)
    }
    assert.equal(url, "https://api.workos.com/user_management/authenticate")
    authenticationCalls.push(JSON.parse(init.body))
    if (authenticationFailure instanceof Error) throw authenticationFailure
    if (authenticationFailure)
      return Response.json(authenticationFailure, { status: 400 })
    return Response.json(
      typeof tokenResponse === "function"
        ? tokenResponse(authenticationCalls.at(-1))
        : tokenResponse
    )
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
  sqlite.close()
})

test("dedicated authorization binds account, personal organization and state without copying the browser session", async () => {
  const pending = await authorize()
  const transaction = await unsealData(
    pending.transactionCookie.split("=").slice(1).join("="),
    { password, ttl: 600 }
  )
  assert.equal(transaction.userId, userId)
  assert.equal(transaction.organizationId, organizationId)
  assert.equal(transaction.browserSessionId, browserSid)
  assert.ok(transaction.codeVerifier)
  assert.match(pending.state, /^billing_/)
  const result = await handleAdminCallback(
    request(
      `/api/auth/callback?code=fresh_code&state=${pending.state}`,
      `${pending.accountCookie}; ${pending.transactionCookie}`
    ),
    env
  )
  assert.equal(result.status, 303)
  assert.equal(
    result.headers.get("location"),
    `${origin}/account?billing=connected`
  )
  assert.ok(
    result.headers
      .getSetCookie()
      .every((value) => !value.startsWith("__Host-photodepot-account="))
  )
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), true)
  const tokens = await storedTokens()
  assert.equal(tokens.sessionId, backendSid)
  assert.equal(tokens.refreshToken, "refresh_backend_rotated")
  assert.equal(authenticationCalls[0].grant_type, "authorization_code")
  assert.equal(authenticationCalls[0].code_verifier, transaction.codeVerifier)
  const cached = await getWorkOSEntitlement(env, userId)
  assert.equal(cached.enabled, true)
  assert.equal(authenticationCalls.length, 1)
  assert.equal(checkoutCalls.length, 0)
})

function enableCheckout() {
  Object.assign(env, {
    PHOTODEPOT_STRIPE_ENABLED: "true",
    PHOTODEPOT_STRIPE_ORIGIN: origin,
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_PRICE_MONTHLY: "price_monthly",
    STRIPE_PRICE_ANNUAL: "price_annual",
  })
}

for (const interval of ["monthly", "annual"]) {
  test(`fresh billing authorization resumes ${interval} Checkout without a dashboard return`, async () => {
    enableCheckout()
    const pending = await authorize(`?action=checkout&interval=${interval}`)
    const transaction = await unsealData(
      pending.transactionCookie.split("=").slice(1).join("="),
      { password, ttl: 600 }
    )
    assert.deepEqual(transaction.intent, { action: "checkout", interval })
    const response = await completeBillingAuthorization(pending)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get("location"), checkoutSession.url)
    assert.equal(checkoutCalls.length, 1)
    assert.equal(
      checkoutCalls[0].params.get("line_items[0][price]"),
      `price_${interval}`
    )
    assert.equal(checkoutCalls[0].params.get("customer"), "cus_billing")
    assert.equal(
      checkoutCalls[0].params.get("success_url"),
      `${origin}/account?billing=success`
    )
    assert.match(
      checkoutCalls[0].headers.get("idempotency-key"),
      /^photodepot-checkout-token_fixture-1$/
    )
    assert.equal((await storedTokens()).sessionId, backendSid)
    assert.ok(
      response.headers
        .getSetCookie()
        .some((value) => value.includes("photodepot-billing-auth=;"))
    )
    assert.equal(
      sqlite.prepare("SELECT operation_token FROM stripe_customers").get()
        .operation_token,
      null
    )
  })
}

test("resumed authorization reuses the existing open Checkout under the billing lease", async () => {
  enableCheckout()
  sqlite
    .prepare(
      "UPDATE stripe_customers SET checkout_session_id=?, checkout_price_id=?, checkout_generation=1"
    )
    .run(checkoutSession.id, "price_monthly")
  const pending = await authorize("?action=checkout&interval=monthly")
  const response = await completeBillingAuthorization(pending)
  assert.equal(response.status, 303)
  assert.equal(response.headers.get("location"), checkoutSession.url)
  assert.equal(checkoutCalls.length, 0)
})

test("authorization rejects malformed, duplicate, unsupported and redirect-bearing intents", async () => {
  enableCheckout()
  const accountCookie = await browserCookie()
  for (const query of [
    "?action=checkout",
    "?interval=monthly",
    "?action=portal&interval=monthly",
    "?action=connect&interval=monthly",
    "?action=checkout&interval=weekly",
    "?action=checkout&interval=monthly&interval=annual",
    "?action=checkout&action=checkout&interval=monthly",
    "?action=checkout&interval=monthly&returnTo=https://attacker.test",
    "?returnTo=https://attacker.test",
  ]) {
    const response = await handleWorkOSBillingAuthorize(
      request(`/api/account/billing/authorize${query}`, accountCookie),
      env
    )
    assert.equal(response.status, 400, query)
    assert.equal(response.headers.has("location"), false)
  }
  delete env.STRIPE_PRICE_ANNUAL
  assert.equal(
    (
      await handleWorkOSBillingAuthorize(
        request(
          "/api/account/billing/authorize?action=checkout&interval=annual",
          accountCookie
        ),
        env
      )
    ).status,
    400
  )
  assert.equal(authenticationCalls.length, 0)
  assert.equal(checkoutCalls.length, 0)
})

test("resumed Checkout requires matching authentication and billing origins", async () => {
  enableCheckout()
  env.PHOTODEPOT_STRIPE_ORIGIN = "https://different.test"
  const response = await handleWorkOSBillingAuthorize(
    request(
      "/api/account/billing/authorize?action=checkout&interval=monthly",
      await browserCookie()
    ),
    env
  )
  assert.equal(response.status, 503)
  assert.equal(response.headers.has("location"), false)
  env.PHOTODEPOT_STRIPE_ORIGIN = origin
  assert.equal(
    (
      await handleWorkOSBillingAuthorize(
        new Request(
          "https://different.test/api/account/billing/authorize?action=checkout&interval=monthly",
          { headers: { cookie: await browserCookie() } }
        ),
        env
      )
    ).status,
    403
  )
  assert.equal(checkoutCalls.length, 0)
})

test("callback ignores untrusted plan and redirect query parameters in favor of sealed intent", async () => {
  enableCheckout()
  const pending = await authorize("?action=checkout&interval=monthly")
  const response = await handleAdminCallback(
    request(
      `/api/auth/callback?code=fresh_code&state=${pending.state}&interval=annual&returnTo=https://attacker.test`,
      `${pending.accountCookie}; ${pending.transactionCookie}`
    ),
    env
  )
  assert.equal(response.status, 303)
  assert.equal(response.headers.get("location"), checkoutSession.url)
  assert.equal(
    checkoutCalls[0].params.get("line_items[0][price]"),
    "price_monthly"
  )
})

test("an invalid sealed continuation never exchanges credentials or creates Checkout", async () => {
  enableCheckout()
  const pending = await authorize()
  const transaction = await unsealData(
    pending.transactionCookie.split("=").slice(1).join("="),
    { password, ttl: 600 }
  )
  for (const intent of [
    { action: "portal", interval: "monthly" },
    { action: "checkout", interval: "weekly" },
    {
      action: "checkout",
      interval: "monthly",
      returnTo: "https://attacker.test",
    },
    null,
  ]) {
    const sealed = await sealData(
      { ...transaction, intent },
      { password, ttl: 600 }
    )
    const response = await completeBillingAuthorization({
      ...pending,
      transactionCookie: `__Host-photodepot-billing-auth=${sealed}`,
    })
    assert.equal(response.status, 401)
  }
  assert.equal(authenticationCalls.length, 0)
  assert.equal(checkoutCalls.length, 0)
})

test("resumed Checkout never redirects to an untrusted provider URL", async () => {
  enableCheckout()
  const pending = await authorize("?action=checkout&interval=monthly")
  checkoutSession.url = "https://attacker.test/checkout"
  const response = await completeBillingAuthorization(pending)
  assert.equal(response.status, 503)
  assert.equal(response.headers.has("location"), false)
  assert.equal(checkoutCalls.length, 1)
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), true)
})

test("authorization rejects missing accounts, administration scopes, and mismatched Stripe links", async () => {
  assert.equal(
    (
      await handleWorkOSBillingAuthorize(
        request("/api/account/billing/authorize"),
        env
      )
    ).status,
    401
  )
  sqlite
    .prepare("UPDATE stripe_customers SET workos_organization_id=?")
    .run(env.WORKOS_ADMIN_ORGANIZATION_ID)
  assert.equal(
    (
      await handleWorkOSBillingAuthorize(
        request("/api/account/billing/authorize", await browserCookie()),
        env
      )
    ).status,
    503
  )
  sqlite
    .prepare("UPDATE stripe_customers SET workos_organization_id=?")
    .run(organizationId)
  organizationResponse.stripe_customer_id = "cus_another"
  assert.equal(
    (
      await handleWorkOSBillingAuthorize(
        request("/api/account/billing/authorize", await browserCookie()),
        env
      )
    ).status,
    409
  )
  assert.equal(authenticationCalls.length, 0)
})

test("callback requires matching sealed state and the original authenticated browser account", async () => {
  const pending = await authorize()
  const cookies = `${pending.accountCookie}; ${pending.transactionCookie}`
  assert.equal(
    (
      await handleAdminCallback(
        request("/api/auth/callback?code=x&state=billing_wrong", cookies),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (
      await handleAdminCallback(
        request(
          `/api/auth/callback?code=x&state=${pending.state}`,
          pending.accountCookie
        ),
        env
      )
    ).status,
    401
  )
  const transaction = await unsealData(
    pending.transactionCookie.split("=").slice(1).join("="),
    { password, ttl: 600 }
  )
  const wrongBrowser = await sealData(
    { ...transaction, browserSessionId: "session_another" },
    { password, ttl: 600 }
  )
  assert.equal(
    (
      await handleAdminCallback(
        request(
          `/api/auth/callback?code=x&state=${pending.state}`,
          `${pending.accountCookie}; __Host-photodepot-billing-auth=${wrongBrowser}`
        ),
        env
      )
    ).status,
    401
  )
  assert.equal(authenticationCalls.length, 0)
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
})

test("new backend credentials require a distinct valid WorkOS session for the exact user and personal organization", async () => {
  for (const claims of [
    { sid: browserSid },
    { sub: "user_another" },
    { org_id: "org_another" },
    { iss: "https://attacker.example" },
    { client_id: "client_another" },
    { exp: Math.floor(epoch / 1000) - 1 },
    { entitlements: [42] },
  ])
    await assert.rejects(store(jwt(claims)))
  const altered = jwt().split(".")
  altered[2] = `${altered[2][0] === "A" ? "B" : "A"}${altered[2].slice(1)}`
  await assert.rejects(store(altered.join(".")))
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM workos_billing_sessions").get().n,
    0
  )
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM workos_entitlements").get().n,
    0
  )
})

test("an absent entitlement is a verified denial and configurable feature slugs are respected", async () => {
  env.PHOTODEPOT_WORKOS_ENTITLEMENT = "premium-photo-tools"
  assert.equal((await store(jwt())).enabled, false)
  const now = Math.floor(epoch / 1000) + 1
  tokenResponse = authentication(
    jwt({ iat: now, entitlements: ["premium-photo-tools"] })
  )
  assert.equal(
    (await getWorkOSEntitlement(env, userId, { forceRefresh: true })).enabled,
    true
  )
})

test("expired JWTs refresh in the mapped organization and persist rotated backend credentials", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: epoch })
  await store(jwt({ exp: Math.floor(epoch / 1000) + 60 }))
  tokenResponse = authentication(
    jwt({
      iat: Math.floor(epoch / 1000) + 61,
      exp: Math.floor(epoch / 1000) + 361,
    }),
    "refresh_backend_second"
  )
  t.mock.timers.tick(61_000)
  const refreshed = await getWorkOSEntitlement(env, userId)
  assert.equal(refreshed.enabled, true)
  assert.equal(refreshed.revision, 2)
  assert.equal(authenticationCalls.length, 1)
  assert.equal(authenticationCalls[0].grant_type, "refresh_token")
  assert.equal(authenticationCalls[0].refresh_token, "refresh_backend_initial")
  assert.equal(authenticationCalls[0].organization_id, organizationId)
  assert.equal((await storedTokens()).refreshToken, "refresh_backend_second")
})

test("force refresh observes revocation of a feature before the previous JWT expires", async () => {
  await store()
  tokenResponse = authentication(jwt({ entitlements: [] }))
  const denied = await getWorkOSEntitlement(env, userId, { forceRefresh: true })
  assert.equal(denied.enabled, false)
  assert.equal(denied.revision, 2)
})

test("invalid_grant invalidates cached entitlement and requires a new dedicated authorization", async () => {
  await store()
  authenticationFailure = {
    error: "invalid_grant",
    error_description: "Session revoked",
  }
  assert.equal(
    await getWorkOSEntitlement(env, userId, { forceRefresh: true }),
    null
  )
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
  const row = sqlite.prepare("SELECT * FROM workos_entitlements").get()
  assert.equal(row.enabled, 0)
  assert.ok(row.expires_at <= Date.now())
  assert.equal(await getWorkOSEntitlement(env, userId), null)
})

test("transient refresh failures preserve credentials and never extend the old proof", async () => {
  await store()
  const before = sqlite.prepare("SELECT * FROM workos_entitlements").get()
  authenticationFailure = new Error("temporary network failure")
  await assert.rejects(
    getWorkOSEntitlement(env, userId, { forceRefresh: true }),
    /temporary network failure/
  )
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), true)
  assert.deepEqual(
    sqlite.prepare("SELECT * FROM workos_entitlements").get(),
    before
  )
  assert.equal((await storedTokens()).refreshToken, "refresh_backend_initial")
})

test("a backend refresh outage preserves billing and device management without authorizing access", async () => {
  enableCheckout()
  env.STRIPE_PORTAL_CONFIGURATION_ID = "bpc_fixture"
  await store()
  const tokens = await storedTokens()
  const encrypted = await sealData(
    {
      ...tokens,
      accessToken: jwt({
        iat: Math.floor(epoch / 1000) - 600,
        exp: Math.floor(epoch / 1000) - 300,
      }),
    },
    { password, ttl: 0 }
  )
  sqlite
    .prepare("UPDATE workos_billing_sessions SET encrypted_tokens = ?")
    .run(encrypted)
  sqlite
    .prepare("UPDATE workos_entitlements SET issued_at = ?, expires_at = ?")
    .run(epoch - 600_000, epoch - 300_000)
  const priorProof = sqlite.prepare("SELECT * FROM workos_entitlements").get()
  const deviceSessionId = "00000000-0000-4000-8000-000000000001"
  sqlite
    .prepare(
      `INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,created_at,updated_at,device_name)
      VALUES (?, 'device_fixture', ?, 'billing@example.test', 'fixture', ?, ?, 'Studio Mac')`
    )
    .run(deviceSessionId, userId, epoch, epoch)
  subscriptionResponse.data = [
    {
      id: "sub_fixture",
      customer: "cus_billing",
      livemode: false,
      status: "active",
      items: {
        data: [
          {
            id: "si_fixture",
            quantity: 1,
            current_period_end: Math.floor(epoch / 1000) + 86400,
            price: {
              id: "price_monthly",
              unit_amount: 2000,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
        has_more: false,
      },
    },
  ]
  const providerFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/v1/billing_portal/configurations/bpc_fixture")
      return Response.json({
        id: "bpc_fixture",
        active: true,
        livemode: false,
        features: {
          subscription_cancel: { enabled: true, mode: "at_period_end" },
        },
      })
    if (url.pathname === "/v1/billing_portal/sessions")
      return Response.json({
        customer: "cus_billing",
        livemode: false,
        configuration: "bpc_fixture",
        url: "https://billing.stripe.com/p/session/cancel_fixture",
      })
    return providerFetch(input, init)
  }
  const cookie = await browserCookie()
  const accountRequest = () => request("/api/account/subscription", cookie)
  assert.equal(
    (await authenticateWorkOSAccount(accountRequest(), env)).userId,
    userId
  )
  authenticationFailure = new Error("temporary network failure")
  const account = await handleAccountSubscription(accountRequest(), env)
  assert.equal(account.status, 200)
  const accountBody = await account.json()
  assert.equal(accountBody.accessUnavailable, true)
  assert.equal(accountBody.access.canUseLocal, false)
  assert.equal(accountBody.access.canHost, false)
  assert.equal(accountBody.devices[0].sessionId, deviceSessionId)
  const billing = await handleAccountBilling(
    request("/api/account/billing?refresh=true", cookie),
    env
  )
  assert.equal(billing.status, 200)
  const billingBody = await billing.json()
  assert.equal(billingBody.accessUnavailable, true)
  assert.equal(billingBody.accessConnected, true)
  assert.equal(billingBody.subscription.status, "active")
  assert.equal(billingBody.portalEnabled, true)
  assert.deepEqual(billingBody.prices.monthly, {
    amount: 2000,
    currency: "usd",
  })
  const post = (path, body) =>
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const cancellation = await handleAccountBilling(
    post("/api/account/billing", { action: "cancel" }),
    env
  )
  assert.equal(cancellation.status, 200)
  assert.equal(
    (await cancellation.json()).url,
    "https://billing.stripe.com/p/session/cancel_fixture"
  )
  const removal = await handleAccountSubscription(
    post("/api/account/subscription", {
      action: "remove-device",
      sessionId: deviceSessionId,
      expectedSessionRevision: 1,
    }),
    env
  )
  assert.equal(removal.status, 200)
  assert.deepEqual((await removal.json()).devices, [])
  // The account-management fallback never changes the receipt authorizer.
  await assert.rejects(getAccountEntitlement(env, userId), /temporary network/)
  assert.deepEqual(
    sqlite.prepare("SELECT * FROM workos_entitlements").get(),
    priorProof
  )
  assert.equal((await storedTokens()).refreshToken, "refresh_backend_initial")
  authenticationFailure = null
  const recovered = await handleAccountSubscription(accountRequest(), env)
  const recoveredBody = await recovered.json()
  assert.equal(recoveredBody.accessUnavailable, false)
  assert.equal(recoveredBody.access.canUseLocal, true)
})

test("a per-account lease serializes force refreshes", async () => {
  await store()
  let entered, release
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const finish = new Promise((resolve) => {
    release = resolve
  })
  const first = getWorkOSEntitlement(env, userId, {
    forceRefresh: true,
    workos: {
      userManagement: {
        async authenticateWithRefreshToken() {
          entered()
          await finish
          return {
            accessToken: jwt(),
            refreshToken: "refresh_serialized",
            user: { id: userId, emailVerified: true },
          }
        },
      },
    },
  })
  await started
  await assert.rejects(
    getWorkOSEntitlement(env, userId, { forceRefresh: true }),
    /being refreshed/
  )
  release()
  assert.equal((await first).enabled, true)
  assert.equal((await storedTokens()).refreshToken, "refresh_serialized")
})

test("successful token rotation survives a later proof persistence failure without issuing new access", async () => {
  await store()
  const before = sqlite.prepare("SELECT * FROM workos_entitlements").get()
  sqlite.exec(
    "CREATE TRIGGER fail_proof BEFORE INSERT ON workos_entitlements BEGIN SELECT RAISE(ABORT,'proof storage unavailable'); END"
  )
  await assert.rejects(
    getWorkOSEntitlement(env, userId, { forceRefresh: true }),
    /proof storage unavailable/
  )
  assert.equal((await storedTokens()).refreshToken, "refresh_backend_rotated")
  assert.deepEqual(
    sqlite.prepare("SELECT * FROM workos_entitlements").get(),
    before
  )
  assert.equal(
    sqlite.prepare("SELECT lease_until FROM workos_billing_sessions").get()
      .lease_until,
    0
  )
})

test("cached snapshots cannot authorize without their dedicated active session", async () => {
  await store()
  sqlite.exec("DELETE FROM workos_billing_sessions")
  assert.equal(await getWorkOSEntitlement(env, userId), null)
})

test("shared verification rejects forged issuer, application, and expired tokens", async () => {
  assert.equal((await verifyWorkOSAccessToken(jwt(), clientId)).sub, userId)
  await assert.rejects(
    verifyWorkOSAccessToken(jwt({ iss: "https://elsewhere.example" }), clientId)
  )
  await assert.rejects(
    verifyWorkOSAccessToken(jwt({ client_id: "client_other" }), clientId)
  )
  await assert.rejects(
    verifyWorkOSAccessToken(
      jwt({ exp: Math.floor(epoch / 1000) - 1 }),
      clientId
    )
  )
})

test("rotating the cookie encryption secret requests reconnection instead of trapping billing in a 503", async () => {
  await store()
  env.WORKOS_COOKIE_PASSWORD = `${password}-rotated`
  Object.assign(env, {
    PHOTODEPOT_STRIPE_ENABLED: "true",
    PHOTODEPOT_STRIPE_ORIGIN: origin,
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_PRICE_MONTHLY: "price_monthly",
  })
  const summary = await billingSummary(env, userId, {
    forceRefresh: true,
    stripe: {
      prices: {
        async retrieve() {
          return {
            id: "price_monthly",
            active: true,
            livemode: false,
            type: "recurring",
            unit_amount: 2000,
            currency: "usd",
            recurring: { interval: "month", interval_count: 1 },
            tax_behavior: "exclusive",
            product: {
              id: "prod_fixture",
              active: true,
              tax_code: "txcd_fixture",
            },
          }
        },
      },
      subscriptions: {
        async list() {
          return { data: [], has_more: false }
        },
      },
    },
  })
  assert.equal(summary.enabled, true)
  assert.equal(summary.hasCustomer, true)
  assert.equal(summary.accessConnected, false)
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
  assert.equal(
    sqlite.prepare("SELECT enabled FROM workos_entitlements").get().enabled,
    0
  )
  assert.equal(authenticationCalls.length, 0)
})

test("corrupt or cross-purpose sealed credentials invalidate their proof and allow reconnect", async () => {
  await store()
  const tokens = await storedTokens()
  for (const encrypted of [
    "corrupt-ciphertext",
    await sealData(
      { ...tokens, purpose: "browser-account" },
      { password, ttl: 0 }
    ),
    await sealData(null, { password, ttl: 0 }),
  ]) {
    sqlite
      .prepare(
        "UPDATE workos_billing_sessions SET encrypted_tokens=?,reauth_needed=0"
      )
      .run(encrypted)
    assert.equal(
      await getWorkOSEntitlement(env, userId, { forceRefresh: true }),
      null
    )
    assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
  }
  assert.equal(authenticationCalls.length, 0)
})

test("terminal OAuth client failures expose reconnection while retryable HTTP failures preserve the grant", async () => {
  await store()
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const error = Object.assign(new Error("transient provider failure"), {
      status,
    })
    await assert.rejects(
      getWorkOSEntitlement(env, userId, {
        forceRefresh: true,
        workos: {
          userManagement: {
            async authenticateWithRefreshToken() {
              throw error
            },
          },
        },
      }),
      /transient provider failure/
    )
    assert.equal(await hasWorkOSBillingSession(env.DB, userId), true)
    assert.equal(
      sqlite.prepare("SELECT enabled FROM workos_entitlements").get().enabled,
      1
    )
  }
  authenticationFailure = {
    error: "invalid_client",
    error_description: "Application credential changed",
  }
  assert.equal(
    await getWorkOSEntitlement(env, userId, { forceRefresh: true }),
    null
  )
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
})

test("a refreshed JWT for a wrong issuer or organization cannot preserve a connected grant", async () => {
  for (const claims of [
    { iss: "https://untrusted.example" },
    { org_id: "org_unrelated" },
  ]) {
    await store()
    tokenResponse = authentication(jwt(claims))
    assert.equal(
      await getWorkOSEntitlement(env, userId, { forceRefresh: true }),
      null
    )
    assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
    assert.equal(
      sqlite.prepare("SELECT enabled FROM workos_entitlements").get().enabled,
      0
    )
  }
})

test("a lost refresh lease cannot invalidate a replacement session", async () => {
  await store()
  let entered, release
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const finish = new Promise((resolve) => {
    release = resolve
  })
  const pending = getWorkOSEntitlement(env, userId, {
    forceRefresh: true,
    workos: {
      userManagement: {
        async authenticateWithRefreshToken() {
          entered()
          await finish
          throw Object.assign(new Error("retired old session"), {
            error: "invalid_grant",
          })
        },
      },
    },
  })
  await started
  sqlite
    .prepare(
      "UPDATE workos_billing_sessions SET operation_token='replacement_lease',lease_until=?"
    )
    .run(Date.now() + 30000)
  release()
  await assert.rejects(pending, /lease expired/)
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), true)
  assert.equal(
    sqlite.prepare("SELECT enabled FROM workos_entitlements").get().enabled,
    1
  )
  assert.equal(
    sqlite.prepare("SELECT operation_token FROM workos_billing_sessions").get()
      .operation_token,
    "replacement_lease"
  )
})

test("changing the configured entitlement key recomputes an unexpired cache from verified token slugs", async () => {
  const initial = await store()
  assert.equal(initial.enabled, true)
  env.PHOTODEPOT_WORKOS_ENTITLEMENT = "another-premium-feature"
  const checked = await getWorkOSEntitlement(env, userId)
  assert.equal(checked.enabled, false)
  assert.equal(checked.revision, initial.revision + 1)
  assert.equal(authenticationCalls.length, 0)
  assert.equal(
    sqlite.prepare("SELECT context FROM workos_entitlements").get().context,
    JSON.stringify([clientId, "another-premium-feature"])
  )
})

test("changing the WorkOS client cannot authorize from an unexpired proof for another application", async () => {
  await store()
  env.WORKOS_CLIENT_ID = "client_another_application"
  assert.equal(await getWorkOSEntitlement(env, userId), null)
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
  assert.equal(
    sqlite.prepare("SELECT enabled FROM workos_entitlements").get().enabled,
    0
  )
  assert.equal(authenticationCalls.length, 0)
})

test("empty cache context is never accepted as an authenticated production proof", async () => {
  await store()
  sqlite.prepare("UPDATE workos_entitlements SET context=''").run()
  sqlite
    .prepare(
      "UPDATE workos_billing_sessions SET encrypted_tokens='untrusted-placeholder'"
    )
    .run()
  assert.equal(await getWorkOSEntitlement(env, userId), null)
  assert.equal(await hasWorkOSBillingSession(env.DB, userId), false)
})

async function completeBillingAuthorization(pending) {
  return handleAdminCallback(
    request(
      `/api/auth/callback?code=fresh_code&state=${pending.state}`,
      `${pending.accountCookie}; ${pending.transactionCookie}`
    ),
    env
  )
}

test("an initially unscoped independent sign-in explicitly refreshes into the private billing organization", async () => {
  const pending = await authorize()
  tokenResponse = (body) =>
    body.grant_type === "authorization_code"
      ? authentication(jwt({ org_id: undefined }), "refresh_fresh_unscoped")
      : authentication(jwt(), "refresh_backend_scoped")
  const response = await completeBillingAuthorization(pending)
  assert.equal(response.status, 303)
  assert.deepEqual(
    authenticationCalls.map((call) => call.grant_type),
    ["authorization_code", "refresh_token"]
  )
  assert.equal(authenticationCalls[1].refresh_token, "refresh_fresh_unscoped")
  assert.equal(authenticationCalls[1].organization_id, organizationId)
  const tokens = await storedTokens()
  assert.equal(tokens.organizationId, organizationId)
  assert.equal(tokens.refreshToken, "refresh_backend_scoped")
  assert.equal((await getWorkOSEntitlement(env, userId)).enabled, true)
})

test("an unscoped grant sharing the browser session never rotates its refresh token or persists billing credentials", async () => {
  const pending = await authorize()
  tokenResponse = authentication(
    jwt({ sid: browserSid, org_id: undefined }),
    "refresh_must_never_rotate"
  )
  const response = await completeBillingAuthorization(pending)
  assert.ok(response.status >= 400)
  assert.deepEqual(
    authenticationCalls.map((call) => call.grant_type),
    ["authorization_code"]
  )
  assert.equal(await storedTokens(), null)
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM workos_entitlements").get().n,
    0
  )
})

test("invalid initial JWTs and mismatched subjects are rejected before organization refresh", async () => {
  const forged = jwt({ org_id: undefined }).split(".")
  forged[2] = `${forged[2][0] === "A" ? "B" : "A"}${forged[2].slice(1)}`
  for (const initialToken of [
    jwt({ org_id: undefined, iss: "https://attacker.example" }),
    jwt({ org_id: undefined, sub: "user_another" }),
    forged.join("."),
  ]) {
    authenticationCalls = []
    const pending = await authorize()
    tokenResponse = authentication(initialToken, "refresh_must_never_rotate")
    const response = await completeBillingAuthorization(pending)
    assert.ok(response.status >= 400)
    assert.deepEqual(
      authenticationCalls.map((call) => call.grant_type),
      ["authorization_code"]
    )
    assert.equal(await storedTokens(), null)
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM workos_entitlements").get().n,
      0
    )
  }
})

test("organization scoping rejects wrong final identity, organization, browser session and verification without replacing existing access", async () => {
  await store(jwt(), "refresh_existing_backend")
  const priorSession = sqlite
    .prepare("SELECT * FROM workos_billing_sessions")
    .get()
  const priorProof = sqlite.prepare("SELECT * FROM workos_entitlements").get()
  const cases = [
    authentication(jwt({ sid: "session_fresh_pending", org_id: "org_wrong" })),
    authentication(jwt({ sid: "session_fresh_pending", sub: "user_another" })),
    authentication(jwt({ sid: browserSid })),
    {
      ...authentication(jwt({ sid: "session_fresh_pending" })),
      user: { ...authentication().user, email_verified: false },
    },
    {
      ...authentication(jwt({ sid: "session_fresh_pending" })),
      user: { ...authentication().user, id: "user_another" },
    },
  ]
  for (const finalResponse of cases) {
    authenticationCalls = []
    const pending = await authorize()
    tokenResponse = (body) =>
      body.grant_type === "authorization_code"
        ? authentication(
            jwt({ sid: "session_fresh_pending", org_id: undefined }),
            "refresh_fresh_unscoped"
          )
        : finalResponse
    const response = await completeBillingAuthorization(pending)
    assert.ok(response.status >= 400)
    assert.deepEqual(
      authenticationCalls.map((call) => call.grant_type),
      ["authorization_code", "refresh_token"]
    )
    assert.equal(authenticationCalls[1].refresh_token, "refresh_fresh_unscoped")
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM workos_billing_sessions").get(),
      priorSession
    )
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM workos_entitlements").get(),
      priorProof
    )
  }
})

test("a transient organization-refresh failure preserves the prior backend session and entitlement", async () => {
  await store(jwt(), "refresh_existing_backend")
  const priorSession = sqlite
    .prepare("SELECT * FROM workos_billing_sessions")
    .get()
  const priorProof = sqlite.prepare("SELECT * FROM workos_entitlements").get()
  const pending = await authorize()
  tokenResponse = (body) => {
    if (body.grant_type === "authorization_code")
      return authentication(
        jwt({ sid: "session_fresh_pending", org_id: undefined }),
        "refresh_fresh_unscoped"
      )
    throw new Error("Temporary provider outage")
  }
  const response = await completeBillingAuthorization(pending)
  assert.equal(response.status, 503)
  assert.deepEqual(
    authenticationCalls.map((call) => call.grant_type),
    ["authorization_code", "refresh_token"]
  )
  assert.deepEqual(
    sqlite.prepare("SELECT * FROM workos_billing_sessions").get(),
    priorSession
  )
  assert.deepEqual(
    sqlite.prepare("SELECT * FROM workos_entitlements").get(),
    priorProof
  )
})
