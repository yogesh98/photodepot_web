import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { after, afterEach, before, beforeEach, test } from "node:test"

const { chromium, expect } = await import(
  process.env.PHOTODEPOT_TEST_PLAYWRIGHT_MODULE || "@playwright/test"
)
const assets = resolve(fileURLToPath(new URL("../out/", import.meta.url)))
const screenshots = process.env.PHOTODEPOT_TEST_SCREENSHOT_DIR
let browser, context, page, server, origin, state

function respond(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(body))
}
function fixtures() {
  return {
    billing: {
      enabled: true,
      intervals: ["monthly", "annual"],
      prices: {
        monthly: { amount: 2000, currency: "usd" },
        annual: { amount: 20000, currency: "usd" },
      },
      subscription: null,
      hasCustomer: false,
      portalEnabled: true,
      trialDays: null,
      accessConnected: true,
      managedBy: "workos",
    },
    access: {
      tier: "free",
      status: "none",
      source: null,
      startsAt: null,
      endsAt: null,
      canUseLocal: false,
      canHost: false,
    },
    devices: [],
    posts: [],
    reads: 0,
    readQueries: [],
    getStatus: 200,
    postStatus: 200,
    postDelay: 0,
    redirect: "https://checkout.stripe.com/c/pay/test_checkout",
    provider: "stripe",
  }
}

before(async () => {
  await readFile(resolve(assets, "account.html"))
  if (screenshots) await mkdir(screenshots, { recursive: true })
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost")
      if (url.pathname === "/api/account/billing") {
        if (request.method === "GET") {
          state.reads++
          state.readQueries.push(Object.fromEntries(url.searchParams))
          return respond(
            response,
            state.getStatus,
            state.getStatus === 200
              ? state.billing
              : { error: "Billing is unavailable." }
          )
        }
        let body = ""
        for await (const chunk of request) body += chunk
        state.posts.push(JSON.parse(body))
        if (state.postDelay)
          await new Promise((done) => setTimeout(done, state.postDelay))
        return respond(
          response,
          state.postStatus,
          state.postStatus === 200
            ? { url: state.redirect, provider: state.provider }
            : { error: "Unable to open billing." }
        )
      }
      if (url.pathname === "/api/account/billing/authorize") {
        response.writeHead(200, { "content-type": "text/html" })
        return response.end("<h1>WorkOS billing fixture</h1>")
      }
      if (url.pathname === "/api/account/subscription")
        return respond(response, 200, {
          user: { email: "customer@example.test" },
          access: state.access,
          devices: state.devices,
        })
      if (url.pathname === "/api/account/dashboard-access")
        return respond(response, 200, {
          user: { id: "user_billing", email: "customer@example.test" },
          canAccessAdmin: false,
        })
      let path = resolve(assets, `.${decodeURIComponent(url.pathname)}`)
      if (!path.startsWith(`${assets}/`)) return respond(response, 404, {})
      if (!extname(path)) path += ".html"
      const contents = await readFile(path)
      response.writeHead(200, {
        "content-type":
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
          }[extname(path)] || "application/octet-stream",
      })
      response.end(contents)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((done, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", done)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({
    channel: process.env.PHOTODEPOT_TEST_BROWSER_CHANNEL || undefined,
  })
})
after(async () => {
  await browser?.close()
  await new Promise((done) => server?.close(done))
})
beforeEach(async () => {
  state = fixtures()
  context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: "reduce",
  })
  // The suite exercises local fixtures and intercepted hosted redirects only.
  await context.route("https://**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Stripe billing fixture</h1>",
    })
  )
  page = await context.newPage()
  page.setDefaultTimeout(5000)
})
afterEach(async () => context?.close())

function setSubscription(overrides = {}, access = true) {
  state.billing.hasCustomer = true
  state.billing.subscription = {
    status: "active",
    endsAt: new Date("2026-11-16T18:00:00Z").getTime(),
    cancelAtPeriodEnd: false,
    interval: "monthly",
    amount: 2000,
    currency: "usd",
    discountsApplied: false,
    ...overrides,
  }
  if (access)
    state.access = {
      tier: "standard",
      status: "active",
      source: "workos",
      startsAt: Date.now(),
      endsAt: Date.now() + 2 * 86400000,
      canUseLocal: true,
      canHost: true,
    }
}
const subscription = () =>
  page.getByRole("region", { name: "Subscription", exact: true })
const card = (name) => page.getByRole("article", { name, exact: true })
const upgrade = (name) =>
  card(name).getByRole("button", { name: "Upgrade", exact: true })
const cancel = (name) =>
  card(name).getByRole("button", { name: "Cancel", exact: true })
async function snapshot(name, mobile = false) {
  if (!screenshots) return
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: resolve(screenshots, `${name}.png`),
    fullPage: true,
  })
}
async function unclutteredAccount() {
  await expect(
    page.getByRole("button", { name: /Request (access|extension)/ })
  ).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Your requests", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByText("Offline access valid until", { exact: true })
  ).toHaveCount(0)
  await expect(page.getByText("Access checked", { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Manage subscription", exact: true })
  ).toHaveCount(0)
  await expect(page.getByRole("link", { name: /Get Photodepot/ })).toHaveCount(
    0
  )
  await expect(
    page.getByRole("group", { name: "Billing period", exact: true })
  ).toHaveCount(0)
  const navigation = page.getByRole("navigation", {
    name: "Account navigation",
    exact: true,
  })
  await expect(navigation.getByRole("link")).toHaveCount(2)
  await expect(
    navigation.getByRole("link", { name: "Subscription", exact: true })
  ).toBeVisible()
  await expect(
    navigation.getByRole("link", { name: "Authorized devices", exact: true })
  ).toBeVisible()
}

test("the default account tab contains only Subscription cards", async () => {
  await page.goto(`${origin}/account`)
  await expect(upgrade("Monthly")).toBeEnabled()
  await expect(subscription().getByRole("article")).toHaveCount(3)
  await expect(
    card("Free").getByText("Current plan", { exact: true })
  ).toBeVisible()
  await expect(card("Free")).toContainText("$0")
  await expect(card("Monthly")).toContainText("$20 / month")
  await expect(card("Yearly")).toContainText("$200 / year")
  await expect(card("Yearly")).toContainText("2 months free")
  await expect(card("Free").getByRole("button")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Authorized devices", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("link", { name: "Subscription", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await unclutteredAccount()
  assert.deepEqual(state.posts, [])
  await snapshot("01-free-desktop")
  await snapshot("02-free-mobile", true)
})

for (const [name, interval] of [
  ["Monthly", "monthly"],
  ["Yearly", "annual"],
])
  test(`free ${name} Upgrade opens one hosted Checkout with the selected price`, async () => {
    state.postDelay = 250
    await page.goto(`${origin}/account`)
    await expect(upgrade(name)).toBeEnabled()
    await upgrade(name).evaluate((button) => {
      button.click()
      button.click()
    })
    await expect(
      page.getByRole("button", { name: "Opening…", exact: true })
    ).toBeVisible()
    await page.waitForURL("https://checkout.stripe.com/c/pay/test_checkout")
    assert.deepEqual(state.posts, [{ action: "checkout", interval }])
  })

test("monthly current plan has Cancel and yearly Upgrade, without a second subscription Checkout", async () => {
  setSubscription()
  state.redirect = "https://billing.stripe.com/p/session/test_upgrade"
  await page.goto(`${origin}/account`)
  await expect(cancel("Monthly")).toBeEnabled()
  await expect(
    card("Monthly").getByText("Current plan", { exact: true })
  ).toBeVisible()
  await expect(card("Monthly")).toContainText("Renews November 16, 2026")
  await expect(
    card("Free").getByText("Current plan", { exact: true })
  ).toHaveCount(0)
  await expect(upgrade("Monthly")).toHaveCount(0)
  await expect(upgrade("Yearly")).toBeEnabled()
  await unclutteredAccount()
  await snapshot("03-monthly-current-desktop")
  await snapshot("04-monthly-current-mobile", true)
  await upgrade("Yearly").click()
  await page.waitForURL("https://billing.stripe.com/p/session/test_upgrade")
  assert.deepEqual(state.posts, [{ action: "upgrade", interval: "annual" }])
})

for (const name of ["Monthly", "Yearly"])
  test(`${name} current-plan Cancel opens hosted cancellation without an immediate local change`, async () => {
    setSubscription(
      name === "Yearly"
        ? {
            interval: "annual",
            amount: 20000,
            endsAt: new Date("2027-10-16T18:00:00Z").getTime(),
          }
        : {}
    )
    state.redirect = "https://billing.stripe.com/p/session/test_cancel"
    state.postDelay = 250
    await page.goto(`${origin}/account`)
    await expect(cancel(name)).toBeEnabled()
    await cancel(name).evaluate((button) => {
      button.click()
      button.click()
    })
    await expect(
      page.getByRole("button", { name: "Opening cancellation…", exact: true })
    ).toBeVisible()
    await page.waitForURL("https://billing.stripe.com/p/session/test_cancel")
    assert.deepEqual(state.posts, [{ action: "cancel" }])
    assert.equal(state.billing.subscription.cancelAtPeriodEnd, false)
  })

test("yearly current plan has Cancel and no upgrade or lower-plan action", async () => {
  setSubscription({
    interval: "annual",
    amount: 20000,
    endsAt: new Date("2027-10-16T18:00:00Z").getTime(),
  })
  await page.goto(`${origin}/account`)
  await expect(cancel("Yearly")).toBeEnabled()
  await expect(
    card("Yearly").getByText("Current plan", { exact: true })
  ).toBeVisible()
  await expect(card("Yearly")).toContainText("Renews October 16, 2027")
  await expect(
    page.getByRole("button", { name: "Upgrade", exact: true })
  ).toHaveCount(0)
  await expect(card("Free").getByRole("button")).toHaveCount(0)
  await expect(card("Monthly").getByRole("button")).toHaveCount(0)
  await snapshot("05-yearly-current-desktop")
  await snapshot("06-yearly-current-mobile", true)
})

test("a discounted yearly subscription stays the current plan and labels its prediscount price", async () => {
  setSubscription({
    interval: "annual",
    amount: 20000,
    discountsApplied: true,
    endsAt: new Date("2027-10-16T18:00:00Z").getTime(),
  })
  await page.goto(`${origin}/account`)
  await expect(cancel("Yearly")).toBeEnabled()
  await expect(card("Yearly")).toContainText("$200 / year")
  await expect(card("Yearly")).toContainText("Price before your discount.")
  await expect(
    card("Yearly").getByText("Current plan", { exact: true })
  ).toBeVisible()
  await expect(
    card("Free").getByText("Current plan", { exact: true })
  ).toHaveCount(0)
  await snapshot("07-discounted-yearly-desktop")
})

test("scheduled cancellation disables the current-plan Cancel and shows the end date", async () => {
  setSubscription({ cancelAtPeriodEnd: true })
  await page.goto(`${origin}/account`)
  await expect(
    card("Monthly").getByRole("button", {
      name: "Cancellation scheduled",
      exact: true,
    })
  ).toBeDisabled()
  await expect(card("Monthly")).toContainText("Ends November 16, 2026")
  await expect(card("Monthly")).not.toContainText("Renews")
  await expect(
    card("Monthly").getByText("Current plan", { exact: true })
  ).toBeVisible()
  assert.deepEqual(state.posts, [])
  await snapshot("08-cancellation-scheduled")
})

for (const status of ["canceled", "incomplete_expired"])
  test(`an ended ${status} subscription returns to Free and offers new paid plans`, async () => {
    setSubscription({ status, endsAt: Date.now() - 86400000 }, false)
    await page.goto(`${origin}/account`)
    await expect(upgrade("Monthly")).toBeEnabled()
    await expect(upgrade("Yearly")).toBeEnabled()
    await expect(
      card("Free").getByText("Current plan", { exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true })
    ).toHaveCount(0)
    await unclutteredAccount()
  })

test("an unconfigured yearly price cannot be purchased or claimed to have a discount", async () => {
  state.billing.intervals = ["monthly"]
  delete state.billing.prices.annual
  await page.goto(`${origin}/account`)
  await expect(upgrade("Monthly")).toBeEnabled()
  await expect(upgrade("Yearly")).toBeDisabled()
  await expect(card("Yearly")).not.toContainText("$200")
  await expect(card("Yearly")).not.toContainText("2 months free")
  assert.deepEqual(state.posts, [])
})

test("unavailable billing has no manual-access fallback", async () => {
  state.billing.enabled = false
  state.billing.intervals = []
  await page.goto(`${origin}/account`)
  await expect(subscription()).toContainText(
    "Subscriptions are temporarily unavailable."
  )
  await expect(upgrade("Monthly")).toBeDisabled()
  await expect(upgrade("Yearly")).toBeDisabled()
  await expect(
    page.getByRole("region", { name: "Authorized devices", exact: true })
  ).toHaveCount(0)
  await unclutteredAccount()
  await page
    .getByRole("link", { name: "Authorized devices", exact: true })
    .click()
  await expect(subscription()).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Authorized devices", exact: true })
  ).toContainText("No authorized devices.")
})

test("Authorized devices is a simple named-device list with contextual removal", async () => {
  state.devices = [
    {
      id: "a".repeat(64),
      deviceName: "Alex’s MacBook Pro",
      activatedAt: Date.now() - 86400000,
      lastUsedAt: Date.now(),
      sessionId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
    },
  ]
  await page.goto(`${origin}/account`)
  await expect(upgrade("Monthly")).toBeEnabled()
  await expect(
    page.getByRole("region", { name: "Authorized devices", exact: true })
  ).toHaveCount(0)
  await page
    .getByRole("link", { name: "Authorized devices", exact: true })
    .click()
  await expect(page).toHaveURL(`${origin}/account#devices`)
  await expect(subscription()).toHaveCount(0)
  await expect(page.getByRole("article")).toHaveCount(0)
  await expect(
    page.getByRole("link", { name: "Authorized devices", exact: true })
  ).toHaveAttribute("aria-current", "page")
  const devices = page.getByRole("region", {
    name: "Authorized devices",
    exact: true,
  })
  await expect(devices.getByRole("listitem")).toHaveCount(1)
  await expect(devices).toContainText("Alex’s MacBook Pro")
  await expect(
    devices.getByRole("button", {
      name: "Remove Alex’s MacBook Pro",
      exact: true,
    })
  ).toBeEnabled()
  await expect(
    devices.getByText("Mac identifier", { exact: true })
  ).toHaveCount(0)
  await snapshot("09-authorized-device-list")
})

test("the Authorized devices tab supports a direct URL, reload, and a return to Subscription", async () => {
  await page.goto(`${origin}/account#devices`)
  const devices = page.getByRole("region", {
    name: "Authorized devices",
    exact: true,
  })
  await expect(devices).toContainText("No authorized devices.")
  await expect(subscription()).toHaveCount(0)
  assert.equal(state.reads, 0)
  await page.reload()
  await expect(devices).toBeVisible()
  await expect(subscription()).toHaveCount(0)
  assert.equal(state.reads, 0)
  await page.getByRole("link", { name: "Subscription", exact: true }).click()
  await expect(page).toHaveURL(`${origin}/account#subscription`)
  await expect(upgrade("Monthly")).toBeEnabled()
  await expect(devices).toHaveCount(0)
  await expect(
    page.getByRole("link", { name: "Subscription", exact: true })
  ).toHaveAttribute("aria-current", "page")
})

test("a pending subscription cannot create duplicate Checkout or show an epoch date", async () => {
  setSubscription({ status: "incomplete", endsAt: 0 }, false)
  await page.goto(`${origin}/account`)
  await expect(subscription()).toContainText("Your payment needs attention.")
  await expect(subscription()).not.toContainText("1970")
  await expect(upgrade("Monthly")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Update payment method", exact: true })
  ).toBeEnabled()
})

test("payment failure recovery stays contextual without claiming feature access was revoked", async () => {
  setSubscription({ status: "past_due" })
  await page.goto(`${origin}/account`)
  await expect(subscription()).toContainText("Your payment needs attention.")
  await expect(
    card("Monthly").getByText("Current plan", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Update payment method", exact: true })
  ).toBeEnabled()
  await expect(subscription()).not.toContainText("Access revoked")
  await snapshot("10-payment-needs-attention")
})

test("expired sessions require sign-in recovery before another purchase", async () => {
  state.postStatus = 401
  await page.goto(`${origin}/account`)
  await upgrade("Monthly").click()
  await expect(subscription().getByRole("alert")).toContainText(
    "Your session expired"
  )
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true })
  ).toHaveAttribute("href", "/api/account/auth/login")
  await expect(upgrade("Monthly")).toBeDisabled()
  await expect(upgrade("Yearly")).toBeDisabled()
  state.postStatus = 200
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(upgrade("Monthly")).toBeEnabled()
  assert.equal(state.posts.length, 1)
})

for (const redirect of [
  "https://checkout.stripe.com.attacker.example/steal",
  "https://other.stripe.com/steal",
  "http://checkout.stripe.com/pay",
  "https://user@checkout.stripe.com/pay",
])
  test(`rejects an untrusted hosted redirect ${redirect}`, async () => {
    state.redirect = redirect
    await page.goto(`${origin}/account`)
    await upgrade("Monthly").click()
    await expect(subscription().getByRole("alert")).toHaveText(
      "Unable to open Stripe. Please try again."
    )
    assert.equal(page.url(), `${origin}/account`)
  })

for (const target of [
  "/api/account/billing/authorize",
  "/api/account/billing/authorize?action=checkout&interval=monthly",
  "/api/account/billing/authorize?action=checkout&interval=annual",
])
  test(`supports only the constrained account confirmation target ${target}`, async () => {
    state.provider = "workos"
    state.redirect = target
    await page.goto(`${origin}/account`)
    await upgrade("Monthly").click()
    await page.waitForURL(`${origin}${target}`)
    assert.deepEqual(state.posts, [{ action: "checkout", interval: "monthly" }])
  })

for (const target of [
  "https://evil.test/api/account/billing/authorize",
  "/api/account/billing/authorize?returnTo=https://evil.test",
  "/api/account/billing/authorize?action=checkout&interval=annual&interval=monthly",
  "/api/account/billing/authorize?action=checkout&interval=annual&other=x",
  "/api/account/billing/authorize?action=portal&interval=annual",
])
  test(`rejects an unexpected confirmation target ${target}`, async () => {
    state.provider = "workos"
    state.redirect = target
    await page.goto(`${origin}/account`)
    await upgrade("Monthly").click()
    await expect(subscription().getByRole("alert")).toHaveText(
      "Unable to confirm your account. Please try again."
    )
    assert.equal(page.url(), `${origin}/account`)
  })

test("a success return query alone cannot claim an active subscription or paid access", async () => {
  await page.goto(`${origin}/account?billing=success`)
  await expect(upgrade("Monthly")).toBeEnabled()
  await expect(
    page.getByText("Your subscription is active.", { exact: true })
  ).toHaveCount(0)
  await expect(
    card("Free").getByText("Current plan", { exact: true })
  ).toBeVisible()
  await expect(
    card("Monthly").getByText("Current plan", { exact: true })
  ).toHaveCount(0)
  assert.deepEqual(state.posts, [])
  assert.deepEqual(state.readQueries, [{ refresh: "true" }])
})

test("checkout returns confirm paid access automatically before claiming activation", async () => {
  await page.clock.install()
  setSubscription({}, false)
  await page.goto(`${origin}/account?billing=success`)
  await expect(subscription()).toContainText("Activating your subscription…")
  await expect(
    page.getByText("Your subscription is active.", { exact: true })
  ).toHaveCount(0)
  state.access = {
    tier: "standard",
    status: "active",
    source: "workos",
    startsAt: Date.now(),
    endsAt: Date.now() + 86400000,
    canUseLocal: true,
    canHost: true,
  }
  await page.clock.fastForward(5000)
  await expect(
    page.getByText("Your subscription is active.", { exact: true })
  ).toBeVisible()
  await expect(subscription()).not.toContainText(
    "Activating your subscription…"
  )
  await expect(upgrade("Monthly")).toHaveCount(0)
})

test("a disconnected paid account can confirm its identity without exposing connection diagnostics", async () => {
  setSubscription({}, false)
  state.billing.accessConnected = false
  state.provider = "workos"
  state.redirect = "/api/account/billing/authorize"
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("button", { name: "Reconnect access", exact: true })
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "Confirm your account", exact: true })
    .click()
  await page.waitForURL(`${origin}/api/account/billing/authorize`)
  assert.deepEqual(state.posts, [{ action: "connect" }])
})

test("unknown paid intervals require contextual billing review instead of an invented current plan", async () => {
  setSubscription({ interval: null })
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("button", { name: "Review billing", exact: true })
  ).toBeEnabled()
  await expect(
    subscription().getByText("Current plan", { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Upgrade", exact: true })
  ).toHaveCount(0)
})

test("malformed provider prices cannot turn into a purchasable offer", async () => {
  state.billing.prices.annual.amount = -20000
  await page.goto(`${origin}/account`)
  await expect(subscription().getByRole("alert")).toContainText(
    "Unable to read billing"
  )
  await expect(upgrade("Monthly")).toBeDisabled()
  await expect(upgrade("Yearly")).toBeDisabled()
  assert.deepEqual(state.posts, [])
})

test("billing outage recovery offers retry without adding account clutter", async () => {
  state.getStatus = 503
  await page.goto(`${origin}/account`)
  await expect(subscription().getByRole("alert")).toHaveText(
    "Billing is unavailable."
  )
  await unclutteredAccount()
  state.getStatus = 200
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(upgrade("Monthly")).toBeEnabled()
})

test("billing returns force a refresh while normal polling uses cached claims", async () => {
  await page.clock.install()
  await page.goto(`${origin}/account?billing=return`)
  await expect(upgrade("Monthly")).toBeEnabled()
  assert.deepEqual(state.readQueries, [{ refresh: "true" }])
  await page.clock.fastForward(30000)
  await expect.poll(() => state.reads).toBe(2)
  assert.deepEqual(state.readQueries[1], {})
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toHaveCount(0)
})
