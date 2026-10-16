import assert from "node:assert/strict"
import { createServer } from "node:http"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { after, afterEach, before, beforeEach, test } from "node:test"

const { chromium, expect } = await import(
  process.env.PHOTODEPOT_TEST_PLAYWRIGHT_MODULE || "@playwright/test"
)
const repository = fileURLToPath(new URL("../", import.meta.url))
const builtAssets = join(repository, "out")
let assets
const screenshots =
  process.env.PHOTODEPOT_TEST_SCREENSHOT_DIR ||
  join(repository, ".wrangler/dashboard-browser")
const day = 86_400_000
const firstMac = "a".repeat(64)
const secondMac = "b".repeat(64)
let browser, context, page, server, origin, state

function fixtures() {
  const now = Date.now()
  const subscription = (id, type, status, days) => ({
    id: `subscription_${id}`,
    userId: `user_${id}`,
    type,
    status,
    startsAt: now - 3 * day,
    endsAt: now + days * day,
    updatedAt: now,
    revision: 1,
    notes: "",
    remindersEnabled: true,
  })
  const users = [
    {
      id: "user_alice",
      email: "alice@example.test",
      firstName: "Alice",
      lastName: "Example",
      emailVerified: true,
      createdAt: now - day,
      subscription: subscription("alice", "trial", "active", 4),
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
  for (const index of [0, 4])
    users[index].managed = {
      userId: users[index].id,
      organizationId: `org_${users[index].id}`,
      enabled: true,
      issuedAt: now,
      expiresAt: now + 300_000,
      revision: 1,
    }
  users[0].subscription.notes =
    "Pilot account <script>window.injected=true</script>"
  users[0].devices = [firstMac, secondMac].map((id, index) => ({
    id,
    activatedAt: now - day,
    sessionId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    revision: 1,
    deviceName: index === 0 ? "Alice’s MacBook Pro" : "Alice’s iMac",
    lastUsedAt: now,
  }))
  for (const user of users) user.devices ??= []
  return {
    users,
    waitlist: [
      {
        id: 3,
        firstName: "Wendy",
        lastName: "Example",
        email: "wendy@example.test",
        heardAboutUs: "A friend",
        createdAt: now - day,
      },
      {
        id: 2,
        firstName: "Will",
        lastName: null,
        email: "will@example.test",
        heardAboutUs: "Search",
        createdAt: now - 8 * day,
      },
      {
        id: 1,
        firstName: "Zoe",
        lastName: "Example",
        email: "zoe@example.test",
        heardAboutUs: "Search",
        createdAt: now - 45 * day,
      },
    ],
    listQueries: [],
    requests: [],
    deviceAudits: [],
    failNext: null,
    listFailure: false,
    delayNext: 0,
    accountRequests: [],
    customerMutations: [],
    customerFailNext: null,
    reviewFailNext: null,
    reviewMutations: [],
    reminderOutbox: [],
    reminderRuns: 0,
    reminderFailure: null,
    reminderDeletedUser: false,
    requestHistoryDelay: 0,
    requestHistoryFailure: null,
    requestHistoryStarted: [],
    requestHistoryResponses: [],
    reminderMode: "disabled",
    dashboardAccess: true,
    dashboardAccessStatus: 200,
    dashboardAccessDelay: 0,
    dashboardAccessQueries: [],
  }
}

function overview() {
  const entries = state.users.map(accountAccess),
    active = entries.filter((item) => item.canHost)
  return {
    totalSubscriptions: state.users.filter((user) => user.managed?.enabled)
      .length,
    active: active.length,
    activeTrials: 0,
    activeStandard: active.length,
    expired: entries.filter((item) => item.status === "expired").length,
    revoked: 0,
    expiringSoon: 0,
    assignedMacs: state.users.reduce(
      (sum, user) => sum + user.devices.length,
      0
    ),
    waitlistTotal: state.waitlist.length,
    waitlistLast30Days: state.waitlist.filter(
      (item) => item.createdAt >= Date.now() - 30 * day
    ).length,
    openRequests: 0,
    asOf: Date.now(),
    expiringWithinDays: 7,
  }
}
function accountAccess(user) {
  const managed = user.managed,
    valid = managed?.enabled && managed.expiresAt > Date.now()
  return {
    tier: valid ? "standard" : "free",
    status: managed?.enabled ? (valid ? "active" : "expired") : "none",
    source: managed?.enabled ? "workos" : null,
    startsAt: managed?.enabled ? managed.issuedAt : null,
    endsAt: managed?.enabled ? managed.issuedAt + 2 * day : null,
    canUseLocal: !!valid,
    canHost: !!valid,
  }
}
function publicUser(user) {
  return { ...user, access: accountAccess(user) }
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
        user: publicUser(user),
        access: accountAccess(user),
        subscription: user.subscription,
        deviceAudit: state.deviceAudits.filter(
          (entry) => entry.userId === user.id
        ),
        devices: (user.deviceHistory ?? user.devices).map((device) => ({
          ...device,
          current: device.current ?? true,
        })),
        audit: [
          {
            id: "audit_test",
            action: "set",
            actor: "owner@example.test",
            createdAt: Date.now(),
            detail: "Assigned 7-day trial",
            reason: "Browser test history reason",
          },
        ],
      })
    }
    state.listQueries.push(Object.fromEntries(url.searchParams))
    const query = (url.searchParams.get("q") || "").trim().toLowerCase()
    const filter = url.searchParams.get("filter") || "all"
    const matching = state.users.filter((user) => {
      const sub = user.subscription
      const access = accountAccess(user),
        active = access.canHost
      if (
        query &&
        ![user.email, user.firstName, user.lastName, sub?.notes]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
        return false
      return (
        filter === "all" ||
        (filter === "active" && active) ||
        (filter === "standard" && active) ||
        (filter === "expired" && access.status === "expired") ||
        (filter === "unassigned" && access.source === null)
      )
    })
    const cursor = url.searchParams.get("cursor")
    const start = cursor
      ? matching.findIndex((user) => user.id === cursor) + 1
      : 0
    const users = matching.slice(start, start + 3)
    return respond(response, 200, {
      users: users.map(publicUser),
      nextCursor:
        start + users.length < matching.length ? users.at(-1).id : null,
      overview: overview(),
      billingMode: "subscriptions",
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
  if (body.action === "remove-device") {
    const device = user.devices.find(
      (device) =>
        device.sessionId === body.sessionId &&
        device.revision === body.expectedSessionRevision
    )
    if (!device)
      return respond(response, 409, { error: "Mac session conflict" })
    user.deviceHistory = user.devices.map((value) => ({
      ...value,
      current: value !== device,
    }))
    user.devices = user.devices.filter((value) => value !== device)
    state.deviceAudits.push({
      id: `device-audit-${state.deviceAudits.length}`,
      userId: user.id,
      sessionId: device.sessionId,
      action: "remove-device",
      actor: "owner@example.test",
      reason: body.reason ?? "",
      createdAt: Date.now(),
    })
    return respond(response, 200, { devices: user.devices })
  }
  return respond(response, 410, {
    error: "Manual access administration retired",
  })
}

async function bodyOf(request) {
  let raw = ""
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw)
}
function customerAccount() {
  const user = state.users[0]
  return {
    user: { email: user.email },
    access: accountAccess(user),
    devices: user.devices,
  }
}
async function customerApi(request, response) {
  if (request.method === "GET") return respond(response, 200, customerAccount())
  const body = await bodyOf(request)
  state.customerMutations.push(body)
  if (state.customerFailNext) {
    const status = state.customerFailNext
    state.customerFailNext = null
    return respond(response, status, {
      error:
        status === 429
          ? "Too many requests. Please try again later."
          : "Session expired",
    })
  }
  if (body.action === "remove-device") {
    const user = state.users[0]
    const device = user.devices.find(
      (device) =>
        device.sessionId === body.sessionId &&
        device.revision === body.expectedSessionRevision
    )
    if (!device)
      return respond(response, 409, {
        error: "This Mac changed. Refresh your account.",
      })
    user.devices = user.devices.filter((value) => value !== device)
    return respond(response, 200, { devices: user.devices })
  }
  return respond(response, 410, { error: "Requests and reminders retired" })
}

async function requestsApi(request, response) {
  state.reviewMutations.push(request.method)
  return respond(response, 410, { error: "Requests retired" })
}
async function remindersApi(request, response) {
  state.reminderRuns++
  return respond(response, 410, { error: "Reminders retired" })
}
function waitlistApi(response, url) {
  const query = (url.searchParams.get("q") || "").toLowerCase()
  const matches = state.waitlist.filter((entry) =>
    [entry.email, entry.firstName, entry.lastName, entry.heardAboutUs]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query)
  )
  const cursor = url.searchParams.get("cursor")
  const remaining = matches.filter(
    (entry) => !cursor || entry.id < Number(cursor)
  )
  const entries = remaining.slice(0, 2)
  const sources = [
    ...new Set(state.waitlist.map((entry) => entry.heardAboutUs)),
  ].map((source) => ({
    source,
    count: state.waitlist.filter((entry) => entry.heardAboutUs === source)
      .length,
  }))
  return respond(response, 200, {
    entries,
    nextCursor:
      remaining.length > entries.length ? String(entries.at(-1).id) : null,
    totalMatches: matches.length,
    overview: {
      total: state.waitlist.length,
      last30Days: state.waitlist.filter(
        (entry) => entry.createdAt >= Date.now() - 30 * day
      ).length,
      sources,
      asOf: Date.now(),
    },
  })
}

before(async () => {
  await readFile(join(builtAssets, "admin/subscriptions.html"))
  assets = await mkdtemp(join(tmpdir(), "photodepot-dashboard-assets-"))
  await cp(builtAssets, assets, { recursive: true })
  await mkdir(screenshots, { recursive: true })
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost")
      if (url.pathname === "/api/admin/subscriptions")
        return await handleApi(request, response, url)
      if (url.pathname === "/api/admin/waitlist")
        return waitlistApi(response, url)
      if (url.pathname === "/api/account/subscription")
        return await customerApi(request, response)
      if (url.pathname === "/api/account/billing")
        return respond(response, 200, {
          enabled: true,
          intervals: ["monthly", "annual"],
          prices: {
            monthly: { amount: 2000, currency: "usd" },
            annual: { amount: 20000, currency: "usd" },
          },
          subscription: accountAccess(state.users[0]).canHost
            ? {
                status: "active",
                endsAt: Date.now() + 30 * day,
                cancelAtPeriodEnd: false,
                interval: "monthly",
                amount: 2000,
                currency: "usd",
              }
            : null,
          hasCustomer: accountAccess(state.users[0]).canHost,
          trialDays: null,
          accessConnected: true,
          managedBy: "workos",
        })
      if (url.pathname === "/api/account/dashboard-access") {
        state.dashboardAccessQueries.push(Object.fromEntries(url.searchParams))
        if (state.dashboardAccessDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, state.dashboardAccessDelay)
          )
        return respond(response, state.dashboardAccessStatus, {
          user: {
            id: state.dashboardAccess ? "user_owner" : "user_alice",
            email: state.dashboardAccess
              ? "owner@example.test"
              : "alice@example.test",
          },
          canAccessAdmin: state.dashboardAccess,
          ...(state.dashboardAccessStatus === 200
            ? {}
            : { error: "Test dashboard access unavailable" }),
        })
      }
      if (url.pathname === "/api/admin/subscription-requests")
        return await requestsApi(request, response, url)
      if (url.pathname === "/api/admin/subscription-reminders")
        return await remindersApi(request, response)
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
  if (assets) await rm(assets, { recursive: true, force: true })
})
beforeEach(async () => {
  state = fixtures()
  context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    timezoneId: "America/New_York",
    reducedMotion: "reduce",
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
    page.getByText("5 accounts shown", { exact: false })
  ).toBeVisible()
}

test("Owners can switch between their individual and admin dashboards", async () => {
  const switcher = page.getByRole("button", {
    name: "Switch dashboard",
    exact: true,
  })
  await expect(switcher).toBeVisible()
  await expect(switcher).toContainText("Admin dashboard")
  await switcher.click()
  await expect(
    page.getByRole("menuitem", { name: "Individual dashboard", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("menuitem", { name: "Admin dashboard", exact: true })
  ).toBeVisible()
  await page
    .getByRole("menuitem", { name: "Individual dashboard", exact: true })
    .click()
  await expect(page).toHaveURL(`${origin}/account`)
  await expect(
    page.getByRole("heading", { name: "Subscription", exact: true, level: 1 })
  ).toBeVisible()
  await expect(switcher).toContainText("Individual dashboard")
  await switcher.click()
  await page
    .getByRole("menuitem", { name: "Admin dashboard", exact: true })
    .click()
  await expect(page).toHaveURL(`${origin}/admin`)
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true })
  ).toBeVisible()
  assert.ok(
    state.dashboardAccessQueries.some((query) => query.dashboard === "admin")
  )
  assert.ok(
    state.dashboardAccessQueries.some(
      (query) => query.dashboard === "individual"
    )
  )
})

test("ordinary customers have no dashboard switcher or admin entry", async () => {
  state.dashboardAccess = false
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("heading", { name: "Subscription", exact: true, level: 1 })
  ).toBeVisible()
  await expect
    .poll(() => state.dashboardAccessQueries.at(-1)?.dashboard)
    .toBe("individual")
  await expect(
    page.getByRole("button", { name: "Switch dashboard", exact: true })
  ).toHaveCount(0)
  await expect(page.getByText("Admin dashboard", { exact: true })).toHaveCount(
    0
  )
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0)
  await expect(
    page.getByRole("navigation", { name: "Account navigation" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /request|reminders/i })
  ).toHaveCount(0)
})

test("dashboard switching stays hidden while access loads or cannot be verified", async () => {
  for (const status of [403, 503]) {
    state.dashboardAccessStatus = status
    state.dashboardAccessDelay = 350
    const lookup = page.waitForResponse((response) =>
      response.url().includes("/api/account/dashboard-access?")
    )
    await page.goto(`${origin}/account`)
    await expect(
      page.getByRole("button", { name: "Switch dashboard", exact: true })
    ).toHaveCount(0)
    await lookup
    await expect(
      page.getByRole("button", { name: "Switch dashboard", exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByText("Admin dashboard", { exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: /request|reminders/i })
    ).toHaveCount(0)
  }
})

test("the shadcn sidebar collapses by trigger and keyboard while preserving navigation", async () => {
  const sidebar = page.locator('[data-slot="sidebar"][data-state]')
  const trigger = page.locator('[data-slot="sidebar-trigger"]')
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
  await expect(trigger).toHaveAccessibleName("Toggle Sidebar")
  await trigger.click()
  await expect(sidebar).toHaveAttribute("data-state", "collapsed")
  await expect(sidebar).toHaveAttribute("data-collapsible", "icon")
  await page.keyboard.press("Control+b")
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
  const nav = page.getByRole("navigation", { name: "Admin navigation" })
  await nav.getByRole("button", { name: /^Waitlist/ }).click()
  await expect(
    page.getByRole("heading", { name: "Waitlist", exact: true })
  ).toBeVisible()
})

test("mobile sidebars open from the header and close after navigating", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${origin}/admin`)
  await expect(
    page.getByRole("navigation", { name: "Admin navigation" })
  ).toBeHidden()
  await page.locator('[data-slot="sidebar-trigger"]').click()
  await expect(
    page.getByRole("dialog", { name: "Sidebar", exact: true })
  ).toBeVisible()
  const nav = page.getByRole("navigation", { name: "Admin navigation" })
  await nav.getByRole("button", { name: /^Waitlist/ }).click()
  await expect(
    page.getByRole("dialog", { name: "Sidebar", exact: true })
  ).toBeHidden()
  await expect(
    page.getByRole("heading", { name: "Waitlist", exact: true })
  ).toBeVisible()

  state.dashboardAccess = false
  await page.goto(`${origin}/account`)
  await page.locator('[data-slot="sidebar-trigger"]').click()
  const accountNav = page.getByRole("navigation", {
    name: "Account navigation",
  })
  await expect(accountNav).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Switch dashboard", exact: true })
  ).toHaveCount(0)
  await accountNav
    .getByRole("link", { name: "Authorized devices", exact: true })
    .click()
  await expect(
    page.getByRole("dialog", { name: "Sidebar", exact: true })
  ).toBeHidden()
  await expect(page).toHaveURL(`${origin}/account#devices`)
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
})

test("sidebar account menus keep logout bound to the displayed dashboard session", async () => {
  await page.route("**/api/**/logout", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<p>Signed out</p>",
    })
  )
  for (const [dashboard, logout] of [
    ["/admin", "/api/auth/logout"],
    ["/account", "/api/account/auth/logout"],
  ]) {
    await page.goto(`${origin}${dashboard}`)
    const accountMenu = page.getByRole("button", {
      name: "Account menu",
      exact: true,
    })
    await accountMenu.click()
    await expect(
      page.getByRole("menuitem", { name: "Sign out", exact: true })
    ).toBeEnabled()
    await page.keyboard.press("Escape")
    await expect(accountMenu).toBeFocused()
    await accountMenu.click()
    const request = page.waitForRequest(`${origin}${logout}`)
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
    assert.equal((await request).method(), "POST")
    await expect(page).toHaveURL(`${origin}${logout}`)
  }
})

test("server-side search, subscription segments, and pagination include the complete directory", async () => {
  await expect(
    page.getByRole("searchbox", { name: "Search accounts" })
  ).toBeVisible()
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("Dan")
  await expect(
    page.getByRole("button", { name: "View dan@example.test", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "View alice@example.test", exact: true })
  ).toHaveCount(0)
  assert.equal(state.listQueries.at(-1).q, "Dan")
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page.getByRole("tab", { name: "Standard", exact: true }).click()
  await expect(page.locator("tbody tr")).toHaveCount(2)
  await expect(
    page.getByRole("button", { name: "View alice@example.test", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("tab", { name: "Trials", exact: true })
  ).toHaveCount(0)
  await expect(page.getByLabel("Expiry", { exact: true })).toHaveCount(0)
  await page.getByRole("tab", { name: "Free accounts", exact: true }).click()
  await expect(page.locator("tbody tr")).toHaveCount(3)
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page.getByRole("searchbox").fill("Pilot account")
  await expect(page.locator("tbody tr")).toHaveCount(1)
  assert.equal(await page.evaluate(() => window.injected), undefined)
  await page.getByRole("button", { name: "Clear filters" }).click()
  await loadAll()
  await page.screenshot({
    path: join(screenshots, "subscriptions-desktop.png"),
    fullPage: true,
  })
})

test("the admin overview links live access counts to Accounts filters", async () => {
  await page.goto(`${origin}/admin`)
  await expect(
    page.getByText("Verified subscription access", { exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "View active access", exact: true })
    .click()
  await expect(page.locator("tbody tr")).toHaveCount(2)
  await expect(
    page.getByRole("tab", { name: "Renewal canceled", exact: true })
  ).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
})

test("waitlist signups have real source counts, server search, pagination, and a scoped export", async () => {
  await page
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Waitlist/ })
    .click()
  await expect(
    page.getByRole("heading", { name: "Waitlist", exact: true })
  ).toBeVisible()
  await expect(page.getByText("2 of 3 matching signups")).toBeVisible()
  await expect(page.getByText("Search · 2", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Load more signups" }).click()
  await expect(page.getByText("3 of 3 matching signups")).toBeVisible()
  await page.getByRole("searchbox", { name: "Search waitlist" }).fill("Zoe")
  await expect(page.getByText("1 of 1 matching signups")).toBeVisible()
  await expect(
    page.getByText("zoe@example.test", { exact: true })
  ).toBeVisible()
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export loaded (1)" }).click()
  const exported = await download
  assert.equal(exported.suggestedFilename(), "photodepot-waitlist.csv")
  const csv = await readFile(await exported.path(), "utf8")
  assert.match(csv, /zoe@example.test/)
  assert.doesNotMatch(csv, /wendy@example.test/)
  await page.getByRole("searchbox", { name: "Search waitlist" }).fill("")
  await expect(page.getByText("2 of 3 matching signups")).toBeVisible()
  await page.screenshot({
    path: join(screenshots, "admin-waitlist-desktop.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
})

test("old profile links preserve access and read-only account history", async () => {
  await page.goto(`${origin}/admin?view=users&user=user_eva`)
  await expect(
    page.getByRole("heading", { name: "Eva Example", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Browser test history reason", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Expiry reminders", { exact: true })).toHaveCount(
    0
  )
  await expect(page.getByRole("button", { name: /renewal/i })).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Eva Example", exact: true })
  ).toBeVisible()
  await page.screenshot({
    path: join(screenshots, "admin-user-profile-desktop.png"),
    fullPage: true,
  })
})

test("an admin removes a named Mac from a free account without granting access", async () => {
  const user = state.users.find(({ id }) => id === "user_cara")
  user.devices = [
    {
      id: firstMac,
      sessionId: "free-session",
      revision: 1,
      activatedAt: Date.now(),
      current: true,
      deviceName: "Cara’s MacBook Air",
      lastUsedAt: Date.now(),
    },
  ]
  await page.goto(`${origin}/admin?view=users&user=user_cara`)
  await expect(
    page.getByText("Cara’s MacBook Air", { exact: true })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /reminders/i })).toHaveCount(0)
  await page
    .getByRole("button", { name: "Remove Cara’s MacBook Air", exact: true })
    .click()
  await page.getByLabel(/Reason for this change/).fill("Retired computer")
  await save("Remove Mac")
  await expect(
    page.getByText("Removed Cara’s MacBook Air from account", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Retired computer", { exact: true })
  ).toBeVisible()
  assert.equal(user.subscription, null)
  assert.deepEqual(user.devices, [])
  assert.equal(state.requests.at(-1).expectedSessionRevision, 1)
  assert.equal("expectedRevision" in state.requests.at(-1), false)
})

test("opening a profile while search is debouncing preserves account details", async () => {
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("Alice")
  await page
    .getByRole("button", { name: "View alice@example.test", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "User management", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Browser test history reason", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: "Remove Alice’s MacBook Pro",
      exact: true,
    })
  ).toBeEnabled()
  await expect
    .poll(() => state.listQueries.some((query) => query.q === "Alice"))
    .toBe(true)
  await expect(
    page.getByText("Browser test history reason", { exact: true })
  ).toBeVisible()
})

test("all workspace sections navigate and failed refreshes can recover", async () => {
  const nav = page.getByRole("navigation", { name: "Admin navigation" })
  for (const name of ["Overview", "Accounts", "Waitlist"]) {
    await nav.getByRole("button", { name: new RegExp(`^${name}`) }).click()
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
    assert.equal(new URL(page.url()).pathname, "/admin")
  }
  await nav.getByRole("button", { name: "Accounts", exact: true }).click()
  state.listFailure = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Test service unavailable"
  )
  state.listFailure = false
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "View alice@example.test", exact: true })
  ).toBeVisible()
})

test("workspace Refresh updates the visible waitlist panel", async () => {
  const nav = page.getByRole("navigation", { name: "Admin navigation" })
  await nav.getByRole("button", { name: /^Waitlist/ }).click()
  await expect(page.getByText("2 of 3 matching signups")).toBeVisible()
  state.waitlist.unshift({
    id: 4,
    firstName: "New",
    lastName: "Photographer",
    email: "new@example.test",
    heardAboutUs: "A friend",
    createdAt: Date.now(),
  })
  await expect(page.getByText("new@example.test", { exact: true })).toHaveCount(
    0
  )
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(
    page.getByText("new@example.test", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("2 of 4 matching signups")).toBeVisible()
  await expect(nav.getByRole("button", { name: /Operations/ })).toHaveCount(0)
  assert.equal(state.reviewMutations.length, 0)
  assert.equal(state.reminderRuns, 0)
})

test("WorkOS-managed accounts offer subscription details and no manual access controls", async () => {
  await page.goto(`${origin}/admin?view=accounts&user=user_alice`)
  await expect(
    page.getByText("WorkOS subscription access", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Offline access valid until", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: /Grant access|Extend access|Restore access|Revoke access|reminders/i,
    })
  ).toHaveCount(0)
  await expect(
    page.getByText("Historical admin notes", { exact: true })
  ).toBeVisible()
  await expect(page.getByText(/Pilot account/)).toBeVisible()
  const nav = page.getByRole("navigation", { name: "Admin navigation" })
  await expect(
    nav.getByRole("button", { name: /Operations|Requests/ })
  ).toHaveCount(0)
  assert.equal(state.requests.length, 0)
  assert.equal(state.reviewMutations.length, 0)
})

test("connected computers show their names and last use in removal confirmation", async () => {
  const account = customerAccount()
  account.devices = state.users[0].devices.map((device, index) => ({
    id: device.id,
    activatedAt: device.activatedAt,
    sessionId: device.sessionId,
    revision: device.revision,
    deviceName: index === 0 ? "Studio MacBook Pro" : null,
    lastUsedAt: index === 0 ? Date.now() - 3_600_000 : null,
  }))
  await page.route("**/api/account/subscription", (route) =>
    route.fulfill({ json: account })
  )
  await page.goto(`${origin}/account#devices`)
  await expect(
    page.getByText("Studio MacBook Pro", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Computer 2", { exact: true })).toBeVisible()
  await expect(page.getByText(/Last used/)).toHaveCount(1)
  const authorized = page.getByRole("region", {
    name: "Authorized devices",
    exact: true,
  })
  await expect(
    authorized
      .locator("ol > li")
      .filter({ hasText: "Computer 2" })
      .getByText(/Authorized/)
  ).toBeVisible()
  await expect(
    authorized.getByText("Mac identifier", { exact: true })
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "Remove Studio MacBook Pro", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("heading", {
      name: "Remove Studio MacBook Pro?",
      exact: true,
    })
  ).toBeVisible()
  await expect(dialog).toContainText(
    "End access to Photodepot on Studio MacBook Pro."
  )
  await expect(dialog.getByText(firstMac, { exact: true })).toBeVisible()
  assert.equal(state.customerMutations.length, 0)
})

test("customer Mac removal requires confirmation and removes only the selected Mac immediately", async () => {
  await page.goto(`${origin}/account#devices`)
  const subscriptionBefore = structuredClone(state.users[0].subscription)
  const devicesBefore = structuredClone(state.users[0].devices)
  const firstRemove = page.getByRole("button", {
    name: "Remove Alice’s MacBook Pro",
    exact: true,
  })
  await expect(firstRemove).toBeEnabled()
  await expect(page.getByText("Request removal", { exact: true })).toHaveCount(
    0
  )
  await firstRemove.click()
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("heading", {
      name: "Remove Alice’s MacBook Pro?",
      exact: true,
    })
  ).toBeVisible()
  await expect(dialog.getByText(firstMac, { exact: true })).toBeVisible()
  await page.screenshot({
    path: join(screenshots, "customer-remove-mac-confirmation.png"),
    fullPage: true,
  })
  assert.equal(state.customerMutations.length, 0)
  assert.deepEqual(state.users[0].subscription, subscriptionBefore)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  assert.equal(state.customerMutations.length, 0)
  await expect(firstRemove).toBeFocused()
  await firstRemove.click()
  await dialog.getByRole("button", { name: "Remove Mac", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const devices = page.getByRole("region", {
    name: "Authorized devices",
    exact: true,
  })
  await expect(devices.locator("ol > li")).toHaveCount(1)
  await expect(
    devices.getByRole("button", { name: "Remove Alice’s iMac", exact: true })
  ).toBeVisible()
  await expect(devices.getByText(firstMac, { exact: true })).toHaveCount(0)
  await expect(devices.getByText(secondMac, { exact: true })).toHaveCount(0)
  assert.deepEqual(state.customerMutations, [
    {
      action: "remove-device",
      deviceId: firstMac,
      sessionId: "00000000-0000-4000-8000-000000000001",
      expectedSessionRevision: 1,
    },
  ])
  assert.equal(state.accountRequests.length, 0)
  assert.equal(state.users[0].devices.length, 1)
  assert.deepEqual(state.users[0].devices[0], devicesBefore[1])
  for (const key of [
    "type",
    "status",
    "startsAt",
    "endsAt",
    "remindersEnabled",
  ])
    assert.equal(state.users[0].subscription[key], subscriptionBefore[key], key)
  assert.equal(state.users[0].subscription.revision, 1)
  await expect(firstRemove).toHaveCount(0)
})

test("customer Mac removal conflicts require fresh account data and a new confirmation", async () => {
  await page.goto(`${origin}/account#devices`)
  await page
    .getByRole("button", { name: "Remove Alice’s MacBook Pro", exact: true })
    .click()
  state.users[0].devices[0].revision++
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Remove Mac", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("This Mac changed")
  await expect(
    dialog.getByRole("button", { name: "Remove Mac", exact: true })
  ).toBeDisabled()
  assert.equal(state.users[0].devices.length, 2)
  assert.equal(state.accountRequests.length, 0)
  await dialog
    .getByRole("button", { name: "Refresh account", exact: true })
    .click()
  await expect(dialog).toHaveCount(0)
  assert.equal(state.customerMutations.length, 1)
  await page
    .getByRole("button", { name: "Remove Alice’s MacBook Pro", exact: true })
    .click()
  await dialog.getByRole("button", { name: "Remove Mac", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  assert.deepEqual(
    state.users[0].devices.map((device) => device.id),
    [secondMac]
  )
  assert.equal(state.customerMutations.at(-1).expectedSessionRevision, 2)
  assert.equal(state.accountRequests.length, 0)
})

test("customer Mac removal preserves devices when the session expires", async () => {
  await page.goto(`${origin}/account#devices`)
  const subscriptionBefore = structuredClone(state.users[0].subscription)
  const devicesBefore = structuredClone(state.users[0].devices)
  await page
    .getByRole("button", { name: "Remove Alice’s iMac", exact: true })
    .click()
  state.customerFailNext = 401
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Remove Mac", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("Your session expired")
  await expect(
    dialog.getByRole("button", { name: "Remove Mac", exact: true })
  ).toBeDisabled()
  await expect(
    dialog.getByRole("link", { name: "Sign in", exact: true })
  ).toHaveAttribute("target", "_blank")
  assert.deepEqual(state.users[0].subscription, subscriptionBefore)
  assert.deepEqual(state.users[0].devices, devicesBefore)
  assert.equal(state.accountRequests.length, 0)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByRole("button", {
      name: "Remove Alice’s MacBook Pro",
      exact: true,
    })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Remove Alice’s iMac", exact: true })
  ).toBeDisabled()
})

test("an existing Mac removal request does not block direct customer removal", async () => {
  state.accountRequests.push({
    id: "request_00000000-0000-4000-8000-000000000007",
    userId: "user_alice",
    email: "alice@example.test",
    action: "reset-device",
    deviceId: firstMac,
    message: "Previously requested removal",
    status: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    adminNote: "",
    handledBy: "",
  })
  await page.goto(`${origin}/account#devices`)
  const remove = page.getByRole("button", {
    name: "Remove Alice’s MacBook Pro",
    exact: true,
  })
  await expect(remove).toBeEnabled()
  await remove.click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove Mac", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  assert.deepEqual(
    state.users[0].devices.map((device) => device.id),
    [secondMac]
  )
  assert.equal(state.accountRequests.length, 1)
  assert.equal(state.accountRequests[0].revision, 1)
})

test("waitlist session expiry provides a sign-in path and recovers after refreshing", async () => {
  await page.route("**/api/admin/waitlist?*", (route) =>
    route.fulfill({
      status: 401,
      contentType: "text/plain",
      body: "Unauthorized",
    })
  )
  await page.goto(`${origin}/admin?view=waitlist`)
  const waitlist = page.getByRole("region", {
    name: "Waitlist signups",
    exact: true,
  })
  await expect(waitlist.getByRole("alert")).toContainText(/session expired/i)
  await expect(waitlist.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "target",
    "_blank"
  )
  await page.unroute("**/api/admin/waitlist?*")
  await page
    .getByRole("button", { name: "Refresh waitlist", exact: true })
    .click()
  await expect(
    page.getByText("wendy@example.test", { exact: true })
  ).toBeVisible()
  await expect(waitlist.getByRole("alert")).toHaveCount(0)
})

test("customer sidebar panels stay separate across navigation, reload and history", async () => {
  await page.goto(`${origin}/account`)
  const subscription = page.getByRole("region", {
    name: "Subscription",
    exact: true,
  })
  const devices = page.getByRole("region", {
    name: "Authorized devices",
    exact: true,
  })
  const navigation = page.getByRole("navigation", {
    name: "Account navigation",
  })
  const subscriptionLink = navigation.getByRole("link", {
    name: "Subscription",
    exact: true,
  })
  const devicesLink = navigation.getByRole("link", {
    name: "Authorized devices",
    exact: true,
  })
  await expect(navigation.getByRole("link")).toHaveCount(2)
  await expect(subscriptionLink).toHaveAttribute("href", "#subscription")
  await expect(devicesLink).toHaveAttribute("href", "#devices")
  await expect(subscription).toBeVisible()
  await expect(devices).toBeHidden()
  await expect(
    subscriptionLink.locator("xpath=self::*[@data-active]")
  ).toHaveCount(1)
  await expect(devicesLink.locator("xpath=self::*[@data-active]")).toHaveCount(
    0
  )
  await expect(
    page.getByRole("heading", { name: "Subscription", level: 1, exact: true })
  ).toBeVisible()
  for (const name of ["Free", "Monthly", "Yearly"]) {
    const plan = subscription.getByRole("article", { name, exact: true })
    await expect(plan).toBeVisible()
    await expect(
      plan.getByRole("heading", { name, level: 3, exact: true })
    ).toBeVisible()
  }
  await expect(subscription.getByRole("article")).toHaveCount(3)
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0)
  await devicesLink.click()
  await expect(page).toHaveURL(`${origin}/account#devices`)
  await expect(devices).toBeVisible()
  await expect(subscription).toBeHidden()
  await expect(devicesLink.locator("xpath=self::*[@data-active]")).toHaveCount(
    1
  )
  await expect(
    subscriptionLink.locator("xpath=self::*[@data-active]")
  ).toHaveCount(0)
  await expect(devices.locator("ol > li")).toHaveCount(2)
  await expect(
    devices.getByText("Mac identifier", { exact: true })
  ).toHaveCount(0)
  await expect(devices.getByText(firstMac, { exact: true })).toHaveCount(0)
  await expect(devices.getByText(secondMac, { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(devices).toBeVisible()
  await expect(subscription).toBeHidden()
  await page.goBack()
  await expect(page).toHaveURL(`${origin}/account`)
  await expect(subscription).toBeVisible()
  await expect(devices).toBeHidden()
  await page.goForward()
  await expect(page).toHaveURL(`${origin}/account#devices`)
  await expect(devices).toBeVisible()
  await expect(subscription).toBeHidden()
  await subscriptionLink.click()
  await expect(page).toHaveURL(`${origin}/account#subscription`)
  await expect(subscription).toBeVisible()
  await expect(devices).toBeHidden()
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: /Request|reminders/i })
  ).toHaveCount(0)
  await expect(page.getByText(/Pilot account/)).toHaveCount(0)
  assert.equal(state.customerMutations.length, 0)
  assert.equal(state.reviewMutations.length, 0)
  assert.equal(state.accountRequests.length, 0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
})

test("initial account load errors offer retry without restoring a persistent Refresh control", async () => {
  await page.route("**/api/account/subscription", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Fixture account temporarily unavailable" },
    })
  )
  await page.goto(`${origin}/account`)
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Fixture account temporarily unavailable" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toHaveCount(0)
  const retry = page.getByRole("button", { name: "Try again", exact: true })
  await expect(retry).toBeEnabled()
  await page.unroute("**/api/account/subscription")
  await retry.click()
  await expect(
    page.getByRole("region", { name: "Authorized devices", exact: true })
  ).toBeHidden()
  await expect(
    page
      .getByRole("region", { name: "Subscription", exact: true })
      .getByRole("article")
  ).toHaveCount(3)
  await expect(retry).toHaveCount(0)
  assert.equal(state.customerMutations.length, 0)
})
