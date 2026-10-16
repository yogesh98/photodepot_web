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
  const now = Date.now()
  return {
    billing: {
      enabled: true,
      intervals: ["monthly", "annual"],
      subscription: null,
      hasCustomer: false,
      portalEnabled: true,
      trialDays: null,
      accessConnected: true,
      managedBy: "workos",
    },
    access: {
      tier: "standard",
      status: "active",
      source: "manual",
      startsAt: now - 86_400_000,
      endsAt: now + 90 * 86_400_000,
      canUseLocal: true,
      canHost: true,
    },
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
          devices: [],
          requests: [],
          reminders: { enabled: true, revision: 0 },
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

test("disabled billing preserves manual access requests without displaying paid offers", async () => {
  state.billing.enabled = false
  state.billing.intervals = []
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("button", { name: "Request extension", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByRole("heading", { name: "Subscription billing" })
  ).toHaveCount(0)
  assert.equal(state.reads, 1)
})

test("subscription review requires an explicit click and prevents duplicate Checkout requests", async () => {
  state.postDelay = 250
  await page.goto(`${origin}/account`)
  const monthly = page.getByRole("button", {
    name: "Review monthly subscription",
    exact: true,
  })
  await expect(monthly).toBeEnabled()
  await expect(
    page.getByRole("button", {
      name: "Review annual subscription",
      exact: true,
    })
  ).toBeEnabled()
  assert.deepEqual(state.posts, [])
  if (screenshots) {
    await page.screenshot({
      path: resolve(screenshots, "billing-offers-desktop.png"),
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  if (screenshots) {
    await page.screenshot({
      path: resolve(screenshots, "billing-offers-mobile-top.png"),
      fullPage: false,
    })
  }
  const billingSection = page.getByRole("region", {
    name: "Subscription billing",
  })
  await billingSection.scrollIntoViewIfNeeded()
  await expect(monthly).toBeInViewport({ ratio: 1 })
  await expect(
    page.getByRole("button", {
      name: "Review annual subscription",
      exact: true,
    })
  ).toBeInViewport({ ratio: 1 })
  if (screenshots) {
    await page.screenshot({
      path: resolve(screenshots, "billing-offers-mobile.png"),
      fullPage: false,
    })
    await billingSection.screenshot({
      path: resolve(screenshots, "billing-offers-mobile-section.png"),
    })
  }
  await page.setViewportSize({ width: 1280, height: 1000 })
  await monthly.evaluate((button) => {
    button.click()
    button.click()
  })
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Opening secure Stripe billing" })
  ).toBeVisible()
  await page.waitForURL("https://checkout.stripe.com/c/pay/test_checkout")
  assert.deepEqual(state.posts, [{ action: "checkout", interval: "monthly" }])
})

test("paid subscriptions retain independent manual requests and hosted billing controls", async () => {
  state.billing.subscription = {
    status: "active",
    endsAt: Date.now() + 30 * 86_400_000,
    cancelAtPeriodEnd: true,
  }
  state.billing.hasCustomer = true
  state.redirect = "https://billing.stripe.com/p/session/test_portal"
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("button", { name: "Manage billing", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByText("Cancellation is scheduled", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Request extension", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByText("Manual access does not change Stripe billing.", {
      exact: false,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: "Review monthly subscription",
      exact: true,
    })
  ).toHaveCount(0)
  if (screenshots)
    await page.screenshot({
      path: resolve(screenshots, "billing-current-subscription.png"),
      fullPage: true,
    })
  await page
    .getByRole("button", { name: "Manage billing", exact: true })
    .click()
  await page.waitForURL("https://billing.stripe.com/p/session/test_portal")
  assert.deepEqual(state.posts, [{ action: "portal" }])
})

for (const status of ["canceled", "incomplete_expired"]) {
  test(`a ${status} paid-only account can request manual access again`, async () => {
    state.billing.subscription = {
      status,
      endsAt: Date.now() - 86_400_000,
      cancelAtPeriodEnd: false,
    }
    state.billing.hasCustomer = true
    state.access = {
      tier: "free",
      status: "revoked",
      source: "workos",
      startsAt: Date.now() - 30 * 86_400_000,
      endsAt: Date.now() - 86_400_000,
      canUseLocal: false,
      canHost: false,
    }
    await page.goto(`${origin}/account`)
    await expect(
      page.getByRole("button", { name: "Request extension", exact: true })
    ).toBeEnabled()
    await expect(
      page.getByRole("button", {
        name: "Review monthly subscription",
        exact: true,
      })
    ).toBeEnabled()
  })
}

test("a pending subscription with no paid period never renders an epoch date or duplicate offer", async () => {
  state.billing.subscription = {
    status: "incomplete",
    endsAt: 0,
    cancelAtPeriodEnd: false,
  }
  state.billing.hasCustomer = true
  await page.goto(`${origin}/account`)
  await expect(
    page.getByText("Subscription access is pending payment confirmation.", {
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: "Review monthly subscription",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Request extension", exact: true })
  ).toBeEnabled()
})

test("expired sessions offer sign-in recovery before another Checkout attempt", async () => {
  state.postStatus = 401
  await page.goto(`${origin}/account`)
  const monthly = page.getByRole("button", {
    name: "Review monthly subscription",
    exact: true,
  })
  await monthly.click()
  await expect(
    page
      .getByRole("region", { name: "Subscription billing" })
      .getByRole("alert")
  ).toContainText("Your session expired")
  await expect(
    page.getByRole("link", { name: "Sign in", exact: true })
  ).toHaveAttribute("href", "/api/account/auth/login")
  await expect(monthly).toBeDisabled()
  state.postStatus = 200
  await page
    .getByRole("button", { name: "Refresh billing", exact: true })
    .click()
  await expect(monthly).toBeEnabled()
  assert.equal(state.posts.length, 1)
})

test("untrusted Stripe-like redirect URLs are rejected locally", async () => {
  state.redirect = "https://checkout.stripe.com.attacker.example/steal"
  await page.goto(`${origin}/account`)
  const monthly = page.getByRole("button", {
    name: "Review monthly subscription",
    exact: true,
  })
  await monthly.click()
  await expect(
    page
      .getByRole("region", { name: "Subscription billing" })
      .getByRole("alert")
  ).toHaveText("Unable to open Stripe. Please try again.")
  assert.equal(page.url(), `${origin}/account`)
  await expect(monthly).toBeEnabled()
})

test("a Checkout return query never claims payment or grants access", async () => {
  state.access = {
    tier: "free",
    status: "none",
    source: null,
    startsAt: null,
    endsAt: null,
    canUseLocal: false,
    canHost: false,
  }
  await page.goto(`${origin}/account?billing=success`)
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Access updates after billing is confirmed" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: "Review monthly subscription",
      exact: true,
    })
  ).toBeEnabled()
  await expect(
    page.getByText("You can log in to the Mac app and join collaboration.", {
      exact: false,
    })
  ).toBeVisible()
  assert.deepEqual(state.posts, [])
})

test("a billing outage does not block independent manual access requests", async () => {
  state.getStatus = 503
  await page.goto(`${origin}/account`)
  const request = page.getByRole("button", {
    name: "Request extension",
    exact: true,
  })
  await expect(
    page
      .getByRole("region", { name: "Subscription billing" })
      .getByRole("alert")
  ).toHaveText("Billing is unavailable.")
  await expect(request).toBeEnabled()
  state.getStatus = 200
  state.billing.enabled = false
  await page
    .getByRole("button", { name: "Refresh billing", exact: true })
    .click()
  await expect(request).toBeEnabled()
})

test("Checkout can connect billing through the fixed WorkOS authorization route", async () => {
  state.provider = "workos"
  state.redirect = "/api/account/billing/authorize"
  await page.goto(`${origin}/account`)
  await page
    .getByRole("button", { name: "Review monthly subscription", exact: true })
    .click()
  await page.waitForURL(`${origin}/api/account/billing/authorize`)
  assert.deepEqual(state.posts, [{ action: "checkout", interval: "monthly" }])
})

test("an existing customer can reconnect subscription access through WorkOS", async () => {
  state.billing.hasCustomer = true
  state.billing.accessConnected = false
  state.provider = "workos"
  state.redirect = "/api/account/billing/authorize"
  await page.goto(`${origin}/account`)
  await page
    .getByRole("button", { name: "Reconnect access", exact: true })
    .click()
  await page.waitForURL(`${origin}/api/account/billing/authorize`)
  assert.deepEqual(state.posts, [{ action: "connect" }])
})

for (const redirect of [
  "https://evil.test/api/account/billing/authorize",
  "/api/account/billing/authorize?returnTo=https://evil.test",
  "/api/account/billing/other",
]) {
  test(`WorkOS redirects reject an unexpected target: ${redirect}`, async () => {
    state.provider = "workos"
    state.redirect = redirect
    await page.goto(`${origin}/account`)
    await page
      .getByRole("button", { name: "Review monthly subscription", exact: true })
      .click()
    await expect(
      page
        .getByRole("region", { name: "Subscription billing" })
        .getByRole("alert")
    ).toHaveText("Unable to connect billing. Please try again.")
    assert.equal(page.url(), `${origin}/account`)
  })
}

test("the WorkOS connection return explains the next purchase step", async () => {
  await page.goto(`${origin}/account?billing=connected`)
  await expect(
    page.getByText("Billing connected. Choose a subscription to continue.", {
      exact: true,
    })
  ).toBeVisible()
})

test("billing returns and manual refresh renew access while polling uses cached claims", async () => {
  await page.clock.install()
  await page.goto(`${origin}/account?billing=return`)
  await expect(
    page.getByRole("button", {
      name: "Review monthly subscription",
      exact: true,
    })
  ).toBeEnabled()
  assert.deepEqual(state.readQueries, [{ refresh: "true" }])
  await page.clock.fastForward(30_000)
  await expect.poll(() => state.reads).toBe(2)
  assert.deepEqual(state.readQueries[1], {})
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => state.reads).toBe(3)
  assert.deepEqual(state.readQueries[2], { refresh: "true" })
})

test("WorkOS access expiry is labeled separately from the Stripe billing period", async () => {
  state.access.source = "workos"
  state.access.endsAt = Date.now() + 2 * 86_400_000
  state.billing.subscription = {
    status: "active",
    endsAt: Date.now() + 30 * 86_400_000,
    cancelAtPeriodEnd: false,
  }
  await page.goto(`${origin}/account`)
  await expect(
    page.getByText("Offline access valid until", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Current billing period ends", { exact: false })
  ).toBeVisible()
})
