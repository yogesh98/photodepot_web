import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { after, afterEach, before, beforeEach, test } from "node:test"

const { chromium, expect } = await import(
  process.env.PHOTODEPOT_TEST_PLAYWRIGHT_MODULE || "@playwright/test"
)
const repository = fileURLToPath(new URL("../", import.meta.url))
const assets = join(repository, "out")
const screenshots =
  process.env.PHOTODEPOT_TEST_SCREENSHOT_DIR ||
  join(repository, ".wrangler/dashboard-browser")
const day = 86_400_000
let browser, context, page, server, origin, state

function fixtures() {
  const now = Date.now()
  const subscription = (id, type, status, days, device = null) => ({
    id: `subscription_${id}`,
    userId: `user_${id}`,
    type,
    status,
    startsAt: now - 3 * day,
    endsAt: now + days * day,
    updatedAt: now,
    revision: 1,
    bindingRevision: 0,
    notes: "",
    device,
  })
  const users = [
    {
      id: "user_alice",
      email: "alice@example.test",
      firstName: "Alice",
      lastName: "Example",
      emailVerified: true,
      createdAt: now - day,
      subscription: subscription("alice", "trial", "active", 4, {
        id: "mac_alice",
        activatedAt: now - day,
        bindingRevision: 0,
      }),
    },
    {
      id: "user_bob",
      email: "bob@example.test",
      firstName: "Bob",
      lastName: "Example",
      emailVerified: false,
      createdAt: now - 2 * day,
      subscription: subscription("bob", "regular", "expired", -1),
    },
    {
      id: "user_cara",
      email: "cara@example.test",
      firstName: "Cara",
      lastName: null,
      emailVerified: true,
      createdAt: now,
      subscription: null,
    },
    {
      id: "user_dan",
      email: "dan@example.test",
      firstName: "Dan",
      lastName: "Example",
      emailVerified: true,
      createdAt: now - 4 * day,
      subscription: subscription("dan", "regular", "revoked", 10),
    },
    {
      id: "user_eva",
      email: "eva@example.test",
      firstName: "Eva",
      lastName: "Example",
      emailVerified: true,
      createdAt: now - 5 * day,
      subscription: subscription("eva", "regular", "active", 60),
    },
  ]
  users[0].subscription.notes =
    "Pilot account <script>window.injected=true</script>"
  return {
    users,
    environment: "development",
    requests: [],
    failNext: null,
    listFailure: false,
    delayNext: 0,
  }
}

function overview() {
  const subscriptions = state.users.flatMap((user) =>
    user.subscription ? [user.subscription] : []
  )
  const now = Date.now()
  const active = subscriptions.filter(
    (subscription) =>
      subscription.status !== "revoked" && subscription.endsAt > now
  )
  return {
    totalSubscriptions: subscriptions.length,
    active: active.length,
    activeTrials: active.filter((subscription) => subscription.type === "trial")
      .length,
    activeStandard: active.filter(
      (subscription) => subscription.type === "regular"
    ).length,
    expired: subscriptions.filter(
      (subscription) =>
        subscription.status !== "revoked" && subscription.endsAt <= now
    ).length,
    revoked: subscriptions.filter(
      (subscription) => subscription.status === "revoked"
    ).length,
    expiringSoon: active.filter(
      (subscription) => subscription.endsAt <= now + 7 * day
    ).length,
    assignedMacs: subscriptions.filter((subscription) => subscription.device)
      .length,
    asOf: now,
    expiringWithinDays: 7,
  }
}

function respond(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(body))
}

async function handleApi(request, response, url) {
  if (request.method === "GET") {
    if (state.listFailure)
      return respond(response, 503, { error: "Test service unavailable" })
    if (url.searchParams.has("history")) {
      const user = state.users.find(
        (user) => user.id === url.searchParams.get("userId")
      )
      return respond(response, 200, {
        subscription: user.subscription,
        devices: user.subscription?.device
          ? [{ ...user.subscription.device, current: true }]
          : [],
        audit: [
          {
            id: "audit_test",
            action: "auto-trial",
            actor: "system",
            createdAt: Date.now(),
            detail: "Activated 7-day signup trial",
            reason: "Browser test history reason",
          },
        ],
      })
    }
    const secondPage = url.searchParams.has("cursor")
    return respond(response, 200, {
      users: secondPage ? state.users.slice(3) : state.users.slice(0, 3),
      nextCursor: secondPage ? null : "user_cara",
      overview: overview(),
      environment: state.environment,
      trialDays: 7,
      billingMode: "manual",
    })
  }
  let raw = ""
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  state.requests.push(body)
  if (state.delayNext) {
    const delay = state.delayNext
    state.delayNext = 0
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  if (state.failNext) {
    const status = state.failNext
    state.failNext = null
    return respond(response, status, {
      error:
        status === 409
          ? "Conflict"
          : status === 401
            ? "Session expired"
            : "Test action unavailable",
    })
  }
  const user = state.users.find((user) => user.id === body.userId)
  if (body.expectedRevision !== (user.subscription?.revision ?? 0))
    return respond(response, 409, { error: "Revision conflict" })
  const now = Date.now()
  if (body.action === "set")
    user.subscription = {
      ...user.subscription,
      id: user.subscription?.id || `subscription_${user.id}`,
      userId: user.id,
      type: body.type,
      status: "active",
      startsAt: now,
      endsAt: body.endsAt || now + body.durationDays * day,
      notes: body.notes,
      bindingRevision: user.subscription?.bindingRevision ?? 0,
      device: user.subscription?.device ?? null,
      revision: (user.subscription?.revision ?? 0) + 1,
      updatedAt: now,
    }
  else {
    const subscription = user.subscription
    if (body.action === "extend")
      subscription.endsAt =
        body.endsAt ||
        Math.max(now, subscription.endsAt) + body.durationDays * day
    if (body.action === "revoke") subscription.status = "revoked"
    if (body.action === "restore")
      subscription.status = subscription.endsAt > now ? "active" : "expired"
    if (body.action === "reset-device") {
      subscription.device = null
      subscription.bindingRevision++
    }
    if (body.action === "update-notes") subscription.notes = body.notes
    subscription.revision++
    subscription.updatedAt = now
  }
  respond(response, 200, { subscription: user.subscription })
}

before(async () => {
  await readFile(join(assets, "admin/subscriptions.html"))
  await mkdir(screenshots, { recursive: true })
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost")
      if (url.pathname === "/api/admin/subscriptions")
        return await handleApi(request, response, url)
      let path = resolve(assets, `.${decodeURIComponent(url.pathname)}`)
      if (!path.startsWith(`${assets}/`)) {
        response.writeHead(404)
        return response.end()
      }
      if (!extname(path)) path += ".html"
      const file = await readFile(path)
      const type =
        {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        }[extname(path)] || "application/octet-stream"
      response.writeHead(200, { "content-type": type })
      response.end(file)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({
    channel: process.env.PHOTODEPOT_TEST_BROWSER_CHANNEL || undefined,
  })
})
after(async () => {
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
})
beforeEach(async () => {
  state = fixtures()
  context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    timezoneId: "America/New_York",
  })
  page = await context.newPage()
  page.setDefaultTimeout(5000)
  await page.goto(`${origin}/admin/subscriptions`)
  await expect(
    page.getByRole("button", { name: "View alice@example.test", exact: true })
  ).toBeVisible()
})
afterEach(async () => {
  await context?.close()
})

async function openAction(action, email = "alice@example.test") {
  await page
    .getByRole("button", { name: `${action} for ${email}`, exact: true })
    .click()
  await expect(page.getByRole("dialog")).toBeVisible()
}
async function save(name) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
}
async function loadAll() {
  await page.getByRole("button", { name: "Load more accounts" }).click()
  await expect(
    page.getByText("Showing 5 of 5 loaded accounts.", { exact: false })
  ).toBeVisible()
}

test("environment, overview, loaded-account filters, and pagination are accurate", async () => {
  await expect(page.getByText("Development", { exact: true })).toBeVisible()
  await expect(
    page.getByText(/only to the local development database/)
  ).toBeVisible()
  await expect(page.getByText("1 trial · 1 standard")).toBeVisible()
  await expect(
    page.getByText(/search and filters apply only to loaded accounts/)
  ).toBeVisible()
  await page
    .getByRole("searchbox", { name: "Search loaded accounts" })
    .fill("Dan")
  await expect(
    page.getByText("No loaded accounts match these filters.")
  ).toBeVisible()
  await page.getByRole("button", { name: "Load more accounts" }).click()
  await expect(
    page.getByRole("button", { name: "View dan@example.test", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "View alice@example.test", exact: true })
  ).toHaveCount(0)
  await expect(page.getByText(/All accounts are loaded/)).toBeVisible()
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page.getByLabel("Status", { exact: true }).selectOption("Revoked")
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page.getByLabel("Type", { exact: true }).selectOption("trial")
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page.getByLabel("Expiry", { exact: true }).selectOption("7")
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page.getByRole("searchbox").fill("Pilot account")
  await expect(page.locator("tbody tr")).toHaveCount(1)
  assert.equal(await page.evaluate(() => window.injected), undefined)
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page.getByLabel("Sort", { exact: true }).selectOption("email")
  assert.match(await page.locator("tbody tr").first().innerText(), /Alice/)
  await page.screenshot({
    path: join(screenshots, "subscriptions-desktop.png"),
    fullPage: true,
  })
  state.environment = "production"
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("Production", { exact: true })).toBeVisible()
  await expect(
    page.getByText(/only to the local development database/)
  ).toHaveCount(0)
})

test("grants support 7-day trials, standard presets, custom durations, and exact expiry", async () => {
  await openAction("Grant subscription", "cara@example.test")
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Subscription type")).toHaveValue("trial")
  await expect(dialog.getByLabel("Subscription length")).toHaveValue("7")
  await dialog.getByLabel(/Admin notes/).fill("Manually reviewed account")
  await dialog
    .getByLabel(/Reason for this change/)
    .fill("Manual trial approval")
  state.delayNext = 300
  await dialog
    .getByRole("button", { name: "Save subscription", exact: true })
    .click()
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled()
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true })
  ).toBeDisabled()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  assert.equal(state.requests.at(-1).durationDays, 7)
  assert.equal(state.requests.at(-1).expectedRevision, 0)
  assert.equal(state.requests.at(-1).reason, "Manual trial approval")
  assert.equal(state.requests.at(-1).notes, "Manually reviewed account")
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
  await openAction("Edit subscription", "cara@example.test")
  await page.getByLabel("Subscription type").selectOption("regular")
  await expect(page.getByLabel("Subscription length")).toHaveValue("30")
  await page.getByLabel("Subscription length").selectOption("custom")
  await page.getByLabel("Number of days").fill("0")
  await expect(
    page.getByRole("button", { name: "Save subscription", exact: true })
  ).toBeDisabled()
  await page.getByLabel("Number of days").fill("1.5")
  await expect(
    page.getByRole("button", { name: "Save subscription", exact: true })
  ).toBeDisabled()
  await page.getByLabel("Number of days").fill("42")
  await save("Save subscription")
  assert.equal(state.requests.at(-1).durationDays, 42)
  assert.equal(state.requests.at(-1).type, "regular")
  await openAction("Edit subscription", "cara@example.test")
  await page.getByLabel("Choose expiry by").selectOption("date")
  await page.getByLabel("New expiry", { exact: false }).fill("2099-01-01T12:00")
  await expect(
    page.getByRole("button", { name: "Save subscription", exact: true })
  ).toBeDisabled()
  const target = new Date(Date.now() + 120 * day)
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  })
    .format(target)
    .replace(" ", "T")
  await page.getByLabel("New expiry", { exact: false }).fill(local)
  await save("Save subscription")
  assert.equal(typeof state.requests.at(-1).endsAt, "number")
  assert.equal("durationDays" in state.requests.at(-1), false)
})

test("details, notes, extension, revoke, restore, and Mac reset use guarded mutations", async () => {
  await page
    .getByRole("button", { name: "View alice@example.test", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Activity history" })
  ).toBeVisible()
  await expect(page.getByText("Browser test history reason")).toBeVisible()
  await expect(page.getByText("mac_alice", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Edit notes", exact: true }).click()
  await page.getByLabel(/Admin notes/).fill("Updated admin note")
  await save("Save notes")
  assert.equal(state.requests.at(-1).action, "update-notes")
  assert.equal(state.requests.at(-1).notes, "Updated admin note")
  await openAction("Extend subscription")
  const currentExpiry = state.users[0].subscription.endsAt
  const startsAt = state.users[0].subscription.startsAt
  await page.getByLabel("Add time").selectOption("14")
  await save("Extend subscription")
  assert.equal(state.users[0].subscription.endsAt, currentExpiry + 14 * day)
  assert.equal(state.users[0].subscription.startsAt, startsAt)
  await openAction("Revoke access")
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close account dialog" })
      .evaluate((button) => button === document.activeElement),
    true
  )
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  assert.equal(
    await page
      .getByRole("button", {
        name: "Revoke access for alice@example.test",
        exact: true,
      })
      .evaluate((button) => button === document.activeElement),
    true
  )
  await openAction("Revoke access")
  await page.getByLabel(/Reason for this change/).fill("Access review")
  await save("Revoke access")
  assert.equal(state.users[0].subscription.status, "revoked")
  await openAction("Restore access")
  await save("Restore subscription")
  assert.equal(state.users[0].subscription.status, "active")
  await page
    .getByRole("button", { name: "View alice@example.test", exact: true })
    .click()
  await page.getByRole("button", { name: "Reset Mac", exact: true }).click()
  await expect(
    page.getByRole("dialog").getByText("mac_alice", { exact: true })
  ).toBeVisible()
  await save("Reset Mac assignment")
  assert.equal(state.users[0].subscription.device, null)
  assert.equal(state.requests.at(-1).action, "reset-device")
  await loadAll()
  await openAction("Restore access", "dan@example.test")
  state.users[3].subscription.endsAt = Date.now() - day
  await save("Restore subscription")
  await expect(
    page
      .locator("tbody tr")
      .filter({ hasText: "dan@example.test" })
      .getByText("Expired", { exact: true })
  ).toBeVisible()
})

test("exact extensions preserve revoked state and expired restores explain the outcome", async () => {
  await loadAll()
  state.users[3].subscription.endsAt = Date.now() - day
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
  await openAction("Restore access", "dan@example.test")
  await expect(
    page.getByText(/access will stay expired until you extend it/)
  ).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await openAction("Extend subscription", "dan@example.test")
  await expect(
    page.getByText(/Access stays revoked; restore it separately/)
  ).toBeVisible()
  await page.getByLabel("Choose expiry by").selectOption("date")
  const target = new Date(Date.now() + 30 * day)
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  })
    .format(target)
    .replace(" ", "T")
  await page.getByLabel("New expiry", { exact: false }).fill(local)
  await save("Extend subscription")
  assert.equal(state.requests.at(-1).action, "extend")
  assert.equal(typeof state.requests.at(-1).endsAt, "number")
  assert.equal(state.users[3].subscription.status, "revoked")
})

test("conflicts, server failures, and session expiry never report a successful change", async () => {
  state.failNext = 409
  await openAction("Extend subscription")
  await page
    .getByRole("button", { name: "Extend subscription", exact: true })
    .click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "changed while you were editing"
  )
  await expect(
    page.getByRole("button", { name: "Extend subscription", exact: true })
  ).toBeDisabled()
  await page
    .getByRole("button", { name: "Refresh account data", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
  state.failNext = 503
  await openAction("Extend subscription")
  await page
    .getByRole("button", { name: "Extend subscription", exact: true })
    .click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Test action unavailable"
  )
  await expect(
    page.getByRole("button", { name: "Extend subscription", exact: true })
  ).toBeEnabled()
  state.failNext = 401
  await page
    .getByRole("button", { name: "Extend subscription", exact: true })
    .click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "session expired"
  )
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Sign in" })
  ).toHaveAttribute("target", "_blank")
  await expect(
    page.getByRole("button", { name: "Extend subscription", exact: true })
  ).toBeDisabled()
})

test("mobile layout and modal keyboard focus remain usable", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    true
  )
  await expect(page.getByRole("searchbox")).toBeVisible()
  await page.screenshot({
    path: join(screenshots, "subscriptions-mobile.png"),
    fullPage: true,
  })
  await openAction("Grant subscription", "cara@example.test")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Shift+Tab")
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement)
    ),
    true
  )
  await page.keyboard.press("Tab")
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement)
    ),
    true
  )
  await page.screenshot({
    path: join(screenshots, "subscription-grant-mobile.png"),
  })
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})
