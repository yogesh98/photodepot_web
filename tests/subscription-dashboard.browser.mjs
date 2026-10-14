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
    devices: device ? [device] : [],
    deviceLimit: 2,
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
        id: firstMac,
        activatedAt: now - day,
        bindingRevision: 0,
        assignmentRevision: 0,
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
  users[0].subscription.devices.push({
    id: secondMac,
    activatedAt: now,
    bindingRevision: 0,
    assignmentRevision: 0,
  })
  return {
    users,
    environment: "development",
    requests: [],
    failNext: null,
    listFailure: false,
    delayNext: 0,
    accountRequests: [],
    customerMutations: [],
    customerFailNext: null,
    reviewFailNext: null,
    reminderOutbox: [],
    reminderRuns: 0,
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
    assignedMacs: subscriptions.reduce(
      (sum, subscription) => sum + subscription.devices.length,
      0
    ),
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
        devices:
          user.subscription?.devices.map((device) => ({
            ...device,
            current: true,
          })) ?? [],
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
      devices: user.subscription?.devices ?? [],
      deviceLimit: 2,
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
      subscription.devices = body.deviceId
        ? subscription.devices.filter((device) => device.id !== body.deviceId)
        : []
      if (!body.deviceId) subscription.bindingRevision++
    }
    if (body.action === "update-notes") subscription.notes = body.notes
    subscription.revision++
    subscription.updatedAt = now
  }
  respond(response, 200, { subscription: user.subscription })
}

async function bodyOf(request) {
  let raw = ""
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw)
}
function customerRequest(item) {
  return {
    id: item.id,
    action: item.action,
    deviceId: item.deviceId,
    message: item.message,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}
function customerAccount() {
  const subscription = state.users[0].subscription
  return {
    environment: state.environment,
    user: { email: state.users[0].email },
    subscription: subscription
      ? {
          type: subscription.type,
          status: subscription.status,
          startsAt: subscription.startsAt,
          endsAt: subscription.endsAt,
          devices: subscription.devices.map(({ id, activatedAt }) => ({
            id,
            activatedAt,
          })),
          deviceLimit: 2,
        }
      : null,
    requests: state.accountRequests
      .filter((item) => item.userId === "user_alice")
      .map(customerRequest),
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
  const action = body.action === "request-renewal" ? "renewal" : "reset-device"
  const existing = state.accountRequests.find(
    (item) =>
      item.userId === "user_alice" &&
      item.action === action &&
      item.deviceId === (body.deviceId ?? null) &&
      ["pending", "acknowledged"].includes(item.status)
  )
  if (existing)
    return respond(response, 200, {
      request: customerRequest(existing),
      created: false,
    })
  const item = {
    id: `request_00000000-0000-4000-8000-${String(state.accountRequests.length + 1).padStart(12, "0")}`,
    userId: "user_alice",
    email: "alice@example.test",
    action,
    deviceId: body.deviceId ?? null,
    message: body.message || "",
    status: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    adminNote: "",
    handledBy: "",
  }
  state.accountRequests.unshift(item)
  respond(response, 201, { request: customerRequest(item), created: true })
}
async function requestsApi(request, response, url) {
  if (request.method === "GET") {
    if (url.searchParams.has("requestId")) {
      const item = state.accountRequests.find(
        (item) => item.id === url.searchParams.get("requestId")
      )
      return respond(response, 200, {
        request: item,
        audit: [
          {
            id: "request_audit",
            action: "created",
            actor: item.email,
            createdAt: item.createdAt,
            note: "",
          },
        ],
      })
    }
    return respond(response, 200, {
      environment: state.environment,
      requests: state.accountRequests
        .filter(
          (item) =>
            url.searchParams.get("includeClosed") === "1" ||
            ["pending", "acknowledged"].includes(item.status)
        )
        .map((item) => ({
          ...item,
          subscription:
            state.users.find((user) => user.id === item.userId)?.subscription ??
            null,
        })),
      openCount: state.accountRequests.filter((item) =>
        ["pending", "acknowledged"].includes(item.status)
      ).length,
      limit: 100,
    })
  }
  const body = await bodyOf(request)
  if (state.reviewFailNext) {
    const status = state.reviewFailNext
    state.reviewFailNext = null
    return respond(response, status, {
      error:
        "This request changed. Refresh the queue before reviewing it again.",
    })
  }
  const item = state.accountRequests.find((item) => item.id === body.requestId)
  if (item.revision !== body.expectedRevision)
    return respond(response, 409, { error: "Request conflict" })
  item.status =
    body.action === "acknowledge"
      ? "acknowledged"
      : body.action === "resolve"
        ? "resolved"
        : "rejected"
  item.adminNote = body.note
  item.handledBy = "owner@example.test"
  item.updatedAt = Date.now()
  item.revision++
  respond(response, 200, { request: item })
}
async function remindersApi(request, response) {
  if (request.method === "POST") {
    const body = await bodyOf(request)
    assert.equal(body.action, "run")
    state.reminderRuns++
    state.reminderOutbox = [
      {
        id: "reminder_preview",
        userId: "user_alice",
        endsAt: state.users[0].subscription.endsAt,
        status: "preview",
        attempts: 0,
        updatedAt: Date.now(),
        subject: "Your Photodepot trial ends soon",
        recipient: "alice@example.test",
        text: "Your trial is expiring. Request renewal from your Photodepot account.",
      },
    ]
  }
  respond(response, 200, {
    environment: state.environment,
    mode: "preview",
    upcoming: [
      {
        subscription: state.users[0].subscription,
        user: {
          id: "user_alice",
          email: "alice@example.test",
          name: "Alice Example",
        },
      },
    ],
    outbox: state.reminderOutbox,
    asOf: Date.now(),
    remindWithinDays: 2,
    queueWithinDays: 7,
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
      if (url.pathname === "/api/account/subscription")
        return await customerApi(request, response)
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
  await expect(page.getByText(firstMac, { exact: true })).toBeVisible()
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
  await page
    .getByRole("button", { name: `Reset Mac ${firstMac}`, exact: true })
    .click()
  await expect(
    page.getByRole("dialog").getByText(firstMac, { exact: true })
  ).toBeVisible()
  await save("Reset Mac assignment")
  assert.deepEqual(
    state.users[0].subscription.devices.map((device) => device.id),
    [secondMac]
  )
  assert.equal(state.requests.at(-1).deviceId, firstMac)
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

test("the customer portal displays only customer data and submits renewal and selected-Mac requests", async () => {
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("heading", { name: "Plan & connected Macs" })
  ).toBeVisible()
  await expect(page.getByText("Free trial", { exact: true })).toBeVisible()
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible()
  await expect(page.getByText(/Pilot account/)).toHaveCount(0)
  await page
    .getByRole("button", { name: "Request renewal", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page
    .getByLabel(/Message to the administrator/)
    .fill("Please renew <script>window.injected=true</script>")
  await page
    .getByRole("button", { name: "Submit request", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Renewal requested", exact: true })
  ).toBeDisabled()
  assert.equal(state.customerMutations.at(-1).action, "request-renewal")
  assert.equal(state.users[0].subscription.revision, 1)
  assert.equal(await page.evaluate(() => window.injected), undefined)
  await page
    .getByRole("button", { name: "Request removal for Mac 1", exact: true })
    .click()
  await expect(
    page.getByRole("dialog").getByText(firstMac, { exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Submit request", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", {
      name: "Removal requested for Mac 1",
      exact: true,
    })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Request removal for Mac 2", exact: true })
  ).toBeEnabled()
  assert.equal(state.customerMutations.at(-1).deviceId, firstMac)
  assert.equal(state.users[0].subscription.devices.length, 2)
  state.accountRequests.find((item) => item.action === "renewal").adminNote =
    "Secret admin context"
  state.accountRequests.find((item) => item.action === "renewal").status =
    "resolved"
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("Completed", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Request renewal", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByText("Secret admin context", { exact: false })
  ).toHaveCount(0)
  await page.screenshot({
    path: join(screenshots, "customer-account-desktop.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Request renewal", exact: true })
  ).toBeVisible()
  await expect(page.locator("header")).toHaveCount(1)
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    true
  )
  await page.screenshot({
    path: join(screenshots, "customer-account-mobile.png"),
    fullPage: true,
  })
})

test("customer request forms preserve keyboard focus and handle rate and session errors", async () => {
  await page.goto(`${origin}/account`)
  await page
    .getByRole("button", { name: "Request renewal", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  assert.equal(
    await dialog
      .getByRole("button", { name: "Cancel" })
      .evaluate((button) => document.activeElement === button),
    true
  )
  await page.keyboard.press("Tab")
  assert.equal(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement)
    ),
    true
  )
  state.customerFailNext = 429
  await dialog.getByRole("button", { name: "Submit request" }).click()
  await expect(dialog.getByRole("alert")).toContainText("Too many requests")
  await expect(
    dialog.getByRole("button", { name: "Submit request" })
  ).toBeEnabled()
  state.customerFailNext = 401
  await dialog.getByRole("button", { name: "Submit request" }).click()
  await expect(
    dialog.getByRole("button", { name: "Submit request" })
  ).toBeDisabled()
  await expect(
    dialog.getByRole("link", { name: "Sign in", exact: true })
  ).toHaveAttribute("target", "_blank")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

test("the admin request queue reviews requests without mutating subscription access", async () => {
  state.accountRequests = [
    {
      id: "request_00000000-0000-4000-8000-000000000001",
      userId: "user_alice",
      email: "alice@example.test",
      action: "renewal",
      deviceId: null,
      message: "Please renew <script>window.injected=true</script>",
      status: "pending",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminNote: "",
      handledBy: "",
    },
  ]
  await page
    .getByRole("button", { name: "Refresh requests", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click()
  await page.getByLabel(/Admin review note/).fill("Follow up with customer")
  await page.getByRole("button", { name: "Save review", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Review request", exact: true })
  ).toBeVisible()
  assert.equal(state.accountRequests[0].status, "acknowledged")
  assert.equal(state.accountRequests[0].adminNote, "Follow up with customer")
  assert.equal(state.users[0].subscription.revision, 1)
  assert.equal(await page.evaluate(() => window.injected), undefined)
  await page.getByRole("button", { name: "Open account", exact: true }).click()
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Account details" })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Close account dialog", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click()
  await page
    .getByLabel("Review outcome", { exact: true })
    .selectOption("resolve")
  await page.getByRole("button", { name: "Save review", exact: true }).click()
  await expect(
    page.getByText("No customer requests in this view.", { exact: true })
  ).toBeVisible()
  assert.equal(state.accountRequests[0].status, "resolved")
  await page.getByLabel("Include completed and declined requests").check()
  await page.getByRole("button", { name: "View review", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Save review", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByText("Follow up with customer", { exact: false })
  ).toBeVisible()
  await page.getByRole("button", { name: "Close review", exact: true }).click()
  await page.screenshot({
    path: join(screenshots, "admin-request-queue.png"),
    fullPage: true,
  })
})

test("request conflicts require refresh and daily reminder checks show previews", async () => {
  state.accountRequests = [
    {
      id: "request_00000000-0000-4000-8000-000000000002",
      userId: "user_alice",
      email: "alice@example.test",
      action: "reset-device",
      deviceId: secondMac,
      message: "Please remove this Mac",
      status: "pending",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminNote: "",
      handledBy: "",
    },
  ]
  await page
    .getByRole("button", { name: "Refresh requests", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click()
  state.reviewFailNext = 409
  await page.getByRole("button", { name: "Save review", exact: true }).click()
  await expect(
    page.getByRole("region", { name: /Customer requests/ }).getByRole("alert")
  ).toContainText("request changed")
  await expect(
    page.getByRole("button", { name: "Save review", exact: true })
  ).toBeDisabled()
  await page
    .getByRole("button", { name: "Refresh requests", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click()
  await page
    .getByLabel("Review outcome", { exact: true })
    .selectOption("reject")
  await page.getByRole("button", { name: "Save review", exact: true }).click()
  assert.equal(state.accountRequests[0].status, "rejected")
  await expect(page.getByText(/No email is sent/)).toBeVisible()
  await page
    .getByRole("button", { name: "Check reminders now", exact: true })
    .click()
  await expect(
    page.getByText("Reminder history and previews (1)", { exact: true })
  ).toBeVisible()
  await page
    .getByText("Reminder history and previews (1)", { exact: true })
    .click()
  await expect(
    page.getByText("Your Photodepot trial ends soon", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("preview", { exact: true })).toBeVisible()
  assert.equal(state.reminderRuns, 1)
})
