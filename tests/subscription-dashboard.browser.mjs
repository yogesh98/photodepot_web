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
    assignedMacs: state.users.reduce(
      (sum, user) => sum + user.devices.length,
      0
    ),
    waitlistTotal: state.waitlist.length,
    waitlistLast30Days: state.waitlist.filter(
      (entry) => entry.createdAt >= now - 30 * day
    ).length,
    openRequests: state.accountRequests.filter((item) =>
      ["pending", "acknowledged"].includes(item.status)
    ).length,
    asOf: now,
    expiringWithinDays: 7,
  }
}

function accountAccess(user) {
  const grant = user.subscription
  if (
    user.managed?.enabled &&
    user.managed.expiresAt > Date.now() &&
    (!grant ||
      grant.status === "revoked" ||
      user.managed.expiresAt >= grant.endsAt)
  )
    return {
      tier: "standard",
      status: "active",
      source: "workos",
      startsAt: user.managed.issuedAt,
      endsAt: user.managed.expiresAt,
      canUseLocal: true,
      canHost: true,
    }
  const status = !grant
    ? "none"
    : grant.status === "revoked"
      ? "revoked"
      : grant.endsAt <= Date.now()
        ? "expired"
        : "active"
  return {
    tier: !grant ? "free" : grant.type === "trial" ? "trial" : "standard",
    status,
    source: grant ? "manual" : null,
    startsAt: grant?.startsAt ?? null,
    endsAt: grant?.endsAt ?? null,
    canUseLocal: status === "active",
    canHost: status === "active",
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
        requests: state.accountRequests.filter(
          (item) => item.userId === user.id
        ),
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
    const now = Date.now()
    const matching = state.users.filter((user) => {
      const sub = user.subscription
      const active = sub && sub.status !== "revoked" && sub.endsAt > now
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
        (filter === "trial" && active && sub.type === "trial") ||
        (filter === "standard" && active && sub.type === "regular") ||
        (filter === "expiring" && active && sub.endsAt <= now + 7 * day) ||
        (filter === "expired" &&
          sub &&
          sub.status !== "revoked" &&
          sub.endsAt <= now) ||
        (filter === "revoked" && sub?.status === "revoked") ||
        (filter === "unassigned" && !sub)
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
      remindersEnabled: user.subscription?.remindersEnabled ?? true,
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
    if (body.action === "update-notes") subscription.notes = body.notes
    if (body.action === "set-reminders")
      subscription.remindersEnabled = body.enabled
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
  const user = state.users[0]
  return {
    user: { email: user.email },
    access: accountAccess(user),
    devices: user.devices,
    reminders: {
      enabled: user.subscription?.remindersEnabled ?? true,
      revision: user.subscription?.revision ?? 0,
    },
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
  if (body.action === "set-reminders") {
    const subscription = state.users[0].subscription
    if (body.expectedRevision !== subscription.revision)
      return respond(response, 409, { error: "Revision conflict" })
    subscription.remindersEnabled = body.enabled
    subscription.revision++
    return respond(response, 200, { reminders: customerAccount().reminders })
  }
  if (body.action !== "request-renewal")
    return respond(response, 400, { error: "Unsupported account action" })
  const action = "renewal"
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
      const delay = state.requestHistoryDelay
      const failure = state.requestHistoryFailure
      state.requestHistoryDelay = 0
      state.requestHistoryFailure = null
      state.requestHistoryStarted.push(item.id)
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      state.requestHistoryResponses.push(item.id)
      if (failure)
        return respond(response, failure, {
          error: "Test request history unavailable",
        })
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
      requests: state.accountRequests
        .filter(
          (item) =>
            url.searchParams.get("includeClosed") === "1" ||
            ["pending", "acknowledged"].includes(item.status)
        )
        .map((item) => ({
          ...item,
          user: (() => {
            const user = state.users.find((user) => user.id === item.userId)
            if (!user) return null
            return Object.fromEntries(
              Object.entries(user).filter(([key]) => key !== "subscription")
            )
          })(),
          subscription:
            state.users.find((user) => user.id === item.userId)?.subscription ??
            null,
          managed:
            state.users.find((user) => user.id === item.userId)?.managed ??
            null,
        })),
      openCount: state.accountRequests.filter((item) =>
        ["pending", "acknowledged"].includes(item.status)
      ).length,
      limit: 100,
    })
  }
  const body = await bodyOf(request)
  state.reviewMutations.push(body)
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
  if (body.action === "approve") {
    const user = state.users.find((user) => user.id === item.userId)
    if (
      (user.subscription?.revision ?? 0) !== body.expectedSubscriptionRevision
    )
      return respond(response, 409, { error: "Access changed" })
    user.subscription = {
      ...user.subscription,
      id: user.subscription?.id ?? `subscription_${user.id}`,
      userId: user.id,
      type: body.type,
      status: "active",
      startsAt: Date.now(),
      endsAt: body.endsAt,
      revision: (user.subscription?.revision ?? 0) + 1,
      notes: user.subscription?.notes ?? "",
      remindersEnabled: user.subscription?.remindersEnabled ?? true,
      updatedAt: Date.now(),
    }
  }
  item.status =
    body.action === "acknowledge"
      ? "acknowledged"
      : ["approve", "resolve"].includes(body.action)
        ? "resolved"
        : "rejected"
  item.adminNote = body.note
  item.handledBy = "owner@example.test"
  item.updatedAt = Date.now()
  item.revision++
  respond(response, 200, { request: item })
}
async function remindersApi(request, response) {
  if (state.reminderFailure)
    return respond(response, state.reminderFailure, {
      error: "Reminder session expired",
    })
  if (request.method === "POST") {
    const body = await bodyOf(request)
    assert.equal(body.action, "run")
    if (state.reminderMode === "disabled")
      return respond(response, 503, {
        error: "Reminder delivery is not configured.",
      })
    state.reminderRuns++
    state.reminderOutbox = [
      {
        id: "reminder_sent",
        userId: "user_alice",
        endsAt: state.users[0].subscription.endsAt,
        status: "sent",
        attempts: 1,
        updatedAt: Date.now(),
        subject: "Your Photodepot trial ends soon",
        recipient: "alice@example.test",
        text: "Your trial is expiring. Request renewal from your Photodepot account.",
      },
    ]
  }
  respond(response, 200, {
    ...(request.method === "POST"
      ? {
          result: {
            processed: 1,
            sent: 1,
            deferred: 0,
            failed: 0,
            cancelled: 0,
            uncertain: 0,
            remaining: false,
          },
        }
      : {}),
    mode: state.reminderMode,
    upcoming: [
      {
        subscription: state.users[0].subscription,
        user: {
          id: state.users[0].id,
          email: state.users[0].email,
          firstName: state.users[0].firstName,
          lastName: state.users[0].lastName,
          emailVerified: state.users[0].emailVerified,
          createdAt: state.users[0].createdAt,
        },
      },
      ...(state.reminderDeletedUser
        ? [
            {
              subscription: {
                ...state.users[0].subscription,
                id: "subscription_deleted",
                userId: "user_deleted",
              },
              user: null,
            },
          ]
        : []),
    ],
    outbox: state.reminderOutbox,
    asOf: Date.now(),
    remindWithinDays: 2,
    queueWithinDays: 7,
  })
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
          enabled: false,
          intervals: [],
          subscription: null,
          hasCustomer: false,
          trialDays: null,
          accessConnected: false,
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
    page.getByRole("heading", { name: "Access & connected Macs" })
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
    page.getByRole("heading", { name: "Access & connected Macs" })
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
    page.getByRole("button", { name: "Turn off reminders", exact: true })
  ).toBeEnabled()
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
      page.getByRole("button", { name: "Request extension", exact: true })
    ).toBeEnabled()
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
    .getByRole("link", { name: "Connected Macs", exact: true })
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
  await page.getByRole("tab", { name: "Revoked", exact: true }).click()
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await expect(
    page.getByRole("button", { name: "View dan@example.test", exact: true })
  ).toBeVisible()
  await page.getByRole("tab", { name: "Trials", exact: true }).click()
  await expect(page.locator("tbody tr")).toHaveCount(1)
  await expect(
    page.getByRole("button", { name: "View alice@example.test", exact: true })
  ).toBeVisible()
  await page.getByLabel("Expiry", { exact: true }).selectOption("expiring")
  await expect.poll(() => state.listQueries.at(-1).filter).toBe("expiring")
  await expect(page.locator("tbody tr")).toHaveCount(1)
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
    page.getByText("1 trial · 1 standard", { exact: true })
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

test("old profile links display access, reminders, and account history", async () => {
  await page.goto(`${origin}/admin?view=users&user=user_eva`)
  await expect(
    page.getByRole("heading", { name: "Eva Example", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Browser test history reason", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Expiry reminders", { exact: true })
  ).toBeVisible()
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

test("Owners can disable and enable account reminders without changing access or Macs", async () => {
  await page.goto(`${origin}/admin?view=accounts&user=user_alice`)
  await expect(
    page.getByRole("button", {
      name: "Turn off reminders for alice@example.test",
      exact: true,
    })
  ).toBeEnabled()
  const user = state.users[0]
  const { startsAt, endsAt, status, type } = user.subscription
  const devices = structuredClone(user.devices)
  await openAction("Turn off reminders")
  await page
    .getByLabel(/Reason for this change/)
    .fill("Customer requested no emails")
  await save("Turn off reminders")
  await expect(
    page.getByText("Expiry reminders disabled for alice@example.test.", {
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: "Turn on reminders for alice@example.test",
      exact: true,
    })
  ).toBeEnabled()
  assert.equal(user.subscription.remindersEnabled, false)
  assert.deepEqual(state.requests.at(-1), {
    action: "set-reminders",
    userId: user.id,
    reason: "Customer requested no emails",
    expectedRevision: 1,
    enabled: false,
  })
  await openAction("Turn on reminders")
  await save("Turn on reminders")
  await expect(
    page.getByRole("button", {
      name: "Turn off reminders for alice@example.test",
      exact: true,
    })
  ).toBeEnabled()
  assert.equal(user.subscription.remindersEnabled, true)
  assert.equal(state.requests.at(-1).expectedRevision, 2)
  assert.equal(state.requests.at(-1).enabled, true)
  assert.deepEqual(
    {
      startsAt: user.subscription.startsAt,
      endsAt: user.subscription.endsAt,
      status: user.subscription.status,
      type: user.subscription.type,
    },
    { startsAt, endsAt, status, type }
  )
  assert.deepEqual(user.devices, devices)
  assert.equal(state.accountRequests.length, 0)
})

test("Owner reminder conflicts require refresh and failures preserve the preference", async () => {
  await page.goto(`${origin}/admin?view=accounts&user=user_alice`)
  await expect(
    page.getByRole("button", {
      name: "Turn off reminders for alice@example.test",
      exact: true,
    })
  ).toBeEnabled()
  state.users[0].subscription.revision++
  await openAction("Turn off reminders")
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: "Turn off reminders",
      exact: true,
    })
    .click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "changed while you were editing"
  )
  await expect(
    page.getByRole("dialog").getByRole("button", {
      name: "Turn off reminders",
      exact: true,
    })
  ).toBeDisabled()
  assert.equal(state.requests.at(-1).expectedRevision, 1)
  assert.equal(state.users[0].subscription.remindersEnabled, true)
  await page
    .getByRole("button", {
      name: "Refresh account data",
      exact: true,
    })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", {
      name: "Turn off reminders for alice@example.test",
      exact: true,
    })
  ).toBeEnabled()
  state.failNext = 503
  await openAction("Turn off reminders")
  const submit = page.getByRole("dialog").getByRole("button", {
    name: "Turn off reminders",
    exact: true,
  })
  await submit.click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Test action unavailable"
  )
  await expect(submit).toBeEnabled()
  assert.equal(state.requests.at(-1).expectedRevision, 2)
  assert.equal(state.users[0].subscription.remindersEnabled, true)
  state.failNext = 401
  await submit.click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "session expired"
  )
  await expect(submit).toBeDisabled()
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Sign in" })
  ).toHaveAttribute("target", "_blank")
  assert.equal(state.users[0].subscription.remindersEnabled, true)
  await expect(
    page.getByText("Expiry reminders disabled for alice@example.test.", {
      exact: true,
    })
  ).toHaveCount(0)
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
  for (const name of ["Overview", "Accounts", "Waitlist", "Operations"]) {
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

test("workspace Refresh updates the visible waitlist and operations panels", async () => {
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
  await nav.getByRole("button", { name: /^Operations/ }).click()
  await expect(
    page.getByText("No customer requests in this view.", { exact: true })
  ).toBeVisible()
  state.accountRequests.push({
    id: "request_00000000-0000-4000-8000-000000000006",
    userId: "user_alice",
    email: "alice@example.test",
    action: "renewal",
    deviceId: null,
    message: "Please extend my access",
    status: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    adminNote: "",
    handledBy: "",
  })
  state.reminderMode = "resend"
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  const requests = page.getByRole("region", { name: /Customer requests/ })
  await expect(
    requests.getByText("Access request · alice@example.test", { exact: true })
  ).toBeVisible()
  await expect(
    requests.getByRole("button", { name: "Review request", exact: true })
  ).toBeVisible()
  await expect(page.getByText(/Reminder delivery is configured/)).toBeVisible()
  assert.equal(state.requests.length, 0)
})

test("grants support 7-day trials, standard presets, custom durations, and exact expiry", async () => {
  await openAction("Grant access", "cara@example.test")
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Access type")).toHaveValue("trial")
  await expect(dialog.getByLabel("Access length")).toHaveValue("7")
  await dialog.getByLabel(/Admin notes/).fill("Manually reviewed account")
  await dialog
    .getByLabel(/Reason for this change/)
    .fill("Manual trial approval")
  state.delayNext = 300
  await dialog
    .getByRole("button", { name: "Grant access", exact: true })
    .click()
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled()
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true })
  ).toBeDisabled()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  assert.ok(
    Math.abs(state.requests.at(-1).endsAt - Date.now() - 7 * day) < 3000
  )
  assert.equal(state.requests.at(-1).expectedRevision, 0)
  assert.equal(state.requests.at(-1).reason, "Manual trial approval")
  assert.equal(state.requests.at(-1).notes, "Manually reviewed account")
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
  await openAction("Grant access", "cara@example.test")
  await page.getByLabel("Access type").selectOption("regular")
  await expect(page.getByLabel("Access length")).toHaveValue("30")
  await page.getByLabel("Access length").selectOption("custom")
  await page.getByLabel("Number of days").fill("0")
  await expect(
    page.getByRole("button", { name: "Grant access", exact: true })
  ).toBeDisabled()
  await page.getByLabel("Number of days").fill("1.5")
  await expect(
    page.getByRole("button", { name: "Grant access", exact: true })
  ).toBeDisabled()
  await page.getByLabel("Number of days").fill("42")
  await save("Grant access")
  assert.ok(
    Math.abs(state.requests.at(-1).endsAt - Date.now() - 42 * day) < 3000
  )
  assert.equal(state.requests.at(-1).type, "regular")
  await openAction("Grant access", "cara@example.test")
  await page.getByLabel("Choose expiry by").selectOption("date")
  await page.getByLabel("New expiry", { exact: false }).fill("2099-01-01T12:00")
  await expect(
    page.getByRole("button", { name: "Grant access", exact: true })
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
  await save("Grant access")
  assert.equal(typeof state.requests.at(-1).endsAt, "number")
  assert.equal("durationDays" in state.requests.at(-1), false)
})

test("WorkOS-managed accounts display access checks and allow independent manual grants", async () => {
  const user = state.users.find((entry) => entry.id === "user_cara")
  user.managed = {
    userId: user.id,
    organizationId: "org_cara_billing",
    enabled: true,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 2 * day,
    revision: 1,
  }
  await page.reload()
  const row = page.getByRole("row").filter({ hasText: user.email })
  await expect(row.getByText(/Billing access managed by WorkOS/)).toBeVisible()
  await openAction("Grant access", user.email)
  await expect(
    page
      .getByRole("dialog")
      .getByText("Manual access does not change Stripe billing.")
  ).toBeVisible()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click()
  await page
    .getByRole("button", { name: `View ${user.email}`, exact: true })
    .click()
  await expect(
    page.getByText("WorkOS subscription access", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Offline access valid until", { exact: true })
  ).toBeVisible()
})

test("a manual access request can be approved while WorkOS billing access is active", async () => {
  const user = state.users[0]
  user.managed = {
    userId: user.id,
    organizationId: "org_alice_billing",
    enabled: true,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 2 * day,
    revision: 1,
  }
  state.accountRequests.push({
    id: "request_00000000-0000-4000-8000-000000000099",
    userId: user.id,
    email: user.email,
    action: "renewal",
    deviceId: null,
    message: "Request additional manual access",
    status: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    adminNote: "",
    handledBy: "",
  })
  await page.goto(`${origin}/admin?view=operations`)
  const requests = page.getByRole("region", { name: /Customer requests/ })
  await expect(
    requests.getByText(/Billing access managed by WorkOS/)
  ).toBeVisible()
  await requests
    .getByRole("button", { name: "Approve and extend", exact: true })
    .click()
  await expect(
    page
      .getByRole("dialog")
      .getByText("Manual access does not change Stripe billing.")
  ).toBeVisible()
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Approve and extend", exact: true })
  ).toBeEnabled()
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
  await openAction("Extend access")
  const currentExpiry = state.users[0].subscription.endsAt
  const startsAt = state.users[0].subscription.startsAt
  await page.getByLabel("Add time").selectOption("14")
  await save("Extend access")
  assert.equal(state.users[0].subscription.endsAt, currentExpiry + 14 * day)
  assert.equal(state.users[0].subscription.startsAt, startsAt)
  await openAction("Revoke access")
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Close account dialog" })
  ).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", {
      name: "Revoke access for alice@example.test",
      exact: true,
    })
  ).toBeFocused()
  await openAction("Revoke access")
  await page.getByLabel(/Reason for this change/).fill("Access review")
  await save("Revoke access")
  assert.equal(state.users[0].subscription.status, "revoked")
  await openAction("Restore access")
  await save("Restore access")
  assert.equal(state.users[0].subscription.status, "active")
  await page
    .getByRole("button", { name: "Remove Alice’s MacBook Pro", exact: true })
    .click()
  await expect(
    page.getByRole("dialog").getByText(/Alice’s MacBook Pro/)
  ).toBeVisible()
  await save("Remove Mac")
  assert.deepEqual(
    state.users[0].devices.map((device) => device.id),
    [secondMac]
  )
  assert.equal(
    state.requests.at(-1).sessionId,
    "00000000-0000-4000-8000-000000000001"
  )
  assert.equal(state.requests.at(-1).action, "remove-device")
  await page
    .getByRole("button", { name: "Back to accounts", exact: true })
    .click()
  await loadAll()
  await openAction("Restore access", "dan@example.test")
  state.users[3].subscription.endsAt = Date.now() - day
  await save("Restore access")
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
    page.getByText(/Expired manual access must also be extended/)
  ).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await openAction("Extend access", "dan@example.test")
  await expect(
    page.getByText(/Revoked access must be restored separately/)
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
  await save("Extend access")
  assert.equal(state.requests.at(-1).action, "extend")
  assert.equal(typeof state.requests.at(-1).endsAt, "number")
  assert.equal(state.users[3].subscription.status, "revoked")
})

test("conflicts, server failures, and session expiry never report a successful change", async () => {
  state.failNext = 409
  await openAction("Extend access")
  await page.getByRole("button", { name: "Extend access", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "changed while you were editing"
  )
  await expect(
    page.getByRole("button", { name: "Extend access", exact: true })
  ).toBeDisabled()
  await page
    .getByRole("button", { name: "Refresh account data", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
  state.failNext = 503
  await openAction("Extend access")
  await page.getByRole("button", { name: "Extend access", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Test action unavailable"
  )
  await expect(
    page.getByRole("button", { name: "Extend access", exact: true })
  ).toBeEnabled()
  state.failNext = 401
  await page.getByRole("button", { name: "Extend access", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "session expired"
  )
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Sign in" })
  ).toHaveAttribute("target", "_blank")
  await expect(
    page.getByRole("button", { name: "Extend access", exact: true })
  ).toBeDisabled()
})

test("mobile layout and modal keyboard focus remain usable", async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
  await expect(page.getByRole("searchbox")).toBeVisible()
  await page.screenshot({
    path: join(screenshots, "subscriptions-mobile.png"),
    fullPage: true,
  })
  await openAction("Grant access", "cara@example.test")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole("button", { name: "Close account dialog", exact: true })
  ).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement))
    )
    .toBe(true)
  await page.keyboard.press("Tab")
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement))
    )
    .toBe(true)
  await page.screenshot({
    path: join(screenshots, "subscription-grant-mobile.png"),
  })
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

test("the customer portal displays only customer data and submits renewal requests", async () => {
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("heading", { name: "Access & connected Macs" })
  ).toBeVisible()
  await expect(page.getByText("Trial access", { exact: true })).toBeVisible()
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible()
  await expect(page.getByText(/Pilot account/)).toHaveCount(0)
  await page
    .getByRole("button", { name: "Request extension", exact: true })
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
    page.getByRole("button", { name: "Request awaiting review", exact: true })
  ).toBeDisabled()
  assert.equal(state.customerMutations.at(-1).action, "request-renewal")
  assert.equal(state.users[0].subscription.revision, 1)
  assert.equal(await page.evaluate(() => window.injected), undefined)
  assert.equal(state.accountRequests.length, 1)
  assert.equal(state.accountRequests[0].action, "renewal")
  assert.equal(state.users[0].devices.length, 2)
  state.accountRequests.find((item) => item.action === "renewal").adminNote =
    "Secret admin context"
  state.accountRequests.find((item) => item.action === "renewal").status =
    "resolved"
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByText("Completed", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Request extension", exact: true })
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
    page.getByRole("button", { name: "Request extension", exact: true })
  ).toBeVisible()
  await expect(page.locator("header")).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
  await page.screenshot({
    path: join(screenshots, "customer-account-mobile.png"),
    fullPage: true,
  })
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
  await page.goto(`${origin}/account`)
  await expect(
    page.getByText("Studio MacBook Pro", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Computer 2", { exact: true })).toBeVisible()
  await expect(page.getByText(/Last used/)).toHaveCount(1)
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
  await page.goto(`${origin}/account`)
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
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible()
  await expect(page.getByText(firstMac, { exact: true })).toHaveCount(0)
  await expect(page.getByText(secondMac, { exact: true })).toHaveCount(1)
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
  await page.goto(`${origin}/account`)
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
  await page.goto(`${origin}/account`)
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
  await page.goto(`${origin}/account`)
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

test("reminder preferences never change access or block extension requests", async () => {
  await page.goto(`${origin}/account`)
  const endsAt = state.users[0].subscription.endsAt
  await page
    .getByRole("button", { name: "Turn off reminders", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Turn on reminders", exact: true })
  ).toBeVisible()
  assert.equal(state.users[0].subscription.remindersEnabled, false)
  assert.equal(state.users[0].subscription.endsAt, endsAt)
  await expect(
    page.getByRole("button", { name: "Request extension", exact: true })
  ).toBeEnabled()
  assert.equal(state.accountRequests.length, 0)
  await page
    .getByRole("button", { name: "Turn on reminders", exact: true })
    .click()
  assert.equal(state.users[0].subscription.remindersEnabled, true)
  assert.equal(state.customerMutations.at(-1).expectedRevision, 2)
})

test("stale reminder preferences refresh without changing access", async () => {
  await page.goto(`${origin}/account`)
  const endsAt = state.users[0].subscription.endsAt
  await expect(
    page.getByRole("button", { name: "Turn off reminders", exact: true })
  ).toBeEnabled()
  state.users[0].subscription.revision++
  await page
    .getByRole("button", { name: "Turn off reminders", exact: true })
    .click()
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Revision conflict"
  )
  assert.equal(state.users[0].subscription.remindersEnabled, true)
  await page
    .getByRole("button", { name: "Turn off reminders", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Turn on reminders", exact: true })
  ).toBeVisible()
  assert.equal(state.users[0].subscription.endsAt, endsAt)
})

test("free accounts request access and keep their named Macs", async () => {
  state.users[0].subscription = null
  await page.goto(`${origin}/account`)
  await expect(
    page.getByRole("button", { name: "Request access", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByText("Alice’s MacBook Pro", { exact: true })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /reminders/i })).toHaveCount(0)
  await page
    .getByRole("button", { name: "Request access", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Submit request", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  assert.equal(state.users[0].subscription, null)
  assert.equal(state.accountRequests[0].status, "pending")
})

test("customer request forms preserve keyboard focus and handle rate and session errors", async () => {
  await page.goto(`${origin}/account`)
  await page
    .getByRole("button", { name: "Request extension", exact: true })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true })
  ).toBeFocused()
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
  await dialog.getByLabel(/Message to the administrator/).focus()
  await page.keyboard.press("Shift+Tab")
  await expect(
    dialog.getByRole("link", { name: "Sign in", exact: true })
  ).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

test("request acknowledgement preserves access and approval extends access atomically", async () => {
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
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
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
    page.getByRole("heading", { name: "User management", exact: true })
  ).toBeVisible()
  await page
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
  await page
    .getByRole("button", { name: "Approve and extend", exact: true })
    .click()
  await page.getByLabel(/Admin review note/).fill("Follow up with customer")
  await save("Approve and extend")
  assert.equal(state.users[0].subscription.revision, 2)
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

test("request conflicts require refresh and daily reminder checks require configured delivery", async () => {
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
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
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
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
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
  await expect(page.getByText(/Email delivery is disabled/)).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Check reminders now", exact: true })
  ).toBeDisabled()
  assert.equal(state.reminderRuns, 0)
  state.reminderMode = "resend"
  await page
    .getByRole("button", { name: "Refresh renewal queue", exact: true })
    .click()
  await expect(page.getByText(/Reminder delivery is configured/)).toBeVisible()
  const runResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/subscription-reminders") &&
      response.request().method() === "POST"
  )
  await page
    .getByRole("button", { name: "Check reminders now", exact: true })
    .click()
  await expect(
    page.getByText("Reminder history (1)", { exact: true })
  ).toBeVisible()
  await page.getByText("Reminder history (1)", { exact: true }).click()
  await expect(
    page.getByText("Your Photodepot trial ends soon", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("sent", { exact: true })).toBeVisible()
  assert.equal((await (await runResponse).json()).result.sent, 1)
  assert.equal(state.reminderRuns, 1)
})

test("queue account details preserve verification and signup metadata", async () => {
  state.users[0].emailVerified = false
  state.users[0].createdAt = Date.now() - 20 * day
  state.reminderDeletedUser = true
  await page
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
  await page.getByRole("button", { name: "Refresh renewal queue" }).click()
  const reminders = page.getByRole("region", { name: "Daily renewal queue" })
  await expect(
    reminders.getByText("user_deleted", { exact: true })
  ).toBeVisible()
  await expect(
    reminders.getByRole("button", { name: "Review access", exact: true })
  ).toHaveCount(1)
  await page.getByRole("button", { name: "Review access", exact: true }).click()
  const profile = page.getByRole("region", {
    name: "User management",
    exact: true,
  })
  await expect(
    profile.getByText("Email unverified", { exact: true })
  ).toBeVisible()
  const joined = new Date(state.users[0].createdAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  })
  await expect(profile.getByText(joined, { exact: true })).toBeVisible()
  state.accountRequests = [
    {
      id: "request_00000000-0000-4000-8000-000000000003",
      userId: "user_alice",
      email: "alice@example.test",
      action: "renewal",
      deviceId: null,
      message: "",
      status: "pending",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminNote: "",
      handledBy: "",
    },
    {
      id: "request_00000000-0000-4000-8000-000000000004",
      userId: "user_deleted",
      email: "deleted@example.test",
      action: "renewal",
      deviceId: null,
      message: "",
      status: "pending",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminNote: "",
      handledBy: "",
    },
  ]
  await page
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
  await page
    .getByRole("button", { name: "Refresh requests", exact: true })
    .click()
  const queue = page.getByRole("region", { name: /Customer requests/ })
  await expect(
    queue
      .locator("li")
      .filter({ hasText: "deleted@example.test" })
      .getByRole("button", { name: "Open account", exact: true })
  ).toBeDisabled()
  await queue
    .locator("li")
    .filter({ hasText: "alice@example.test" })
    .getByRole("button", { name: "Open account", exact: true })
    .click()
  await expect(
    profile.getByText("Email unverified", { exact: true })
  ).toBeVisible()
  await expect(profile.getByText(joined, { exact: true })).toBeVisible()
})

test("request review retries transient failures and ignores history from a closed review", async () => {
  state.accountRequests = [
    {
      id: "request_00000000-0000-4000-8000-000000000005",
      userId: "user_alice",
      email: "alice@example.test",
      action: "renewal",
      deviceId: null,
      message: "",
      status: "pending",
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminNote: "",
      handledBy: "",
    },
  ]
  await page
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
  await page
    .getByRole("button", { name: "Refresh requests", exact: true })
    .click()
  state.requestHistoryDelay = 200
  state.requestHistoryFailure = 503
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click()
  await expect.poll(() => state.requestHistoryStarted.length).toBe(1)
  await page.getByRole("button", { name: "Close review", exact: true }).click()
  await page
    .getByRole("button", { name: "Review request", exact: true })
    .click()
  await expect.poll(() => state.requestHistoryResponses.length).toBe(2)
  await expect(
    page.getByText("Test request history unavailable", { exact: true })
  ).toHaveCount(0)
  await page.getByLabel(/Admin review note/).fill("Keep this note for retry")
  state.reviewFailNext = 503
  await page.getByRole("button", { name: "Save review", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Save review", exact: true })
  ).toBeEnabled()
  await expect(page.getByLabel(/Admin review note/)).toHaveValue(
    "Keep this note for retry"
  )
  await page.getByRole("button", { name: "Save review", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Save review", exact: true })
  ).toHaveCount(0)
  assert.equal(state.accountRequests[0].status, "acknowledged")
  assert.equal(state.accountRequests[0].adminNote, "Keep this note for retry")
})

test("non-JSON unauthorized responses disable customer and reminder mutations until refresh", async () => {
  await page.route("**/api/admin/subscription-reminders", (route) =>
    route.fulfill({
      status: 401,
      contentType: "text/plain",
      body: "Unauthorized",
    })
  )
  await page
    .getByRole("navigation", { name: "Admin navigation" })
    .getByRole("button", { name: /^Operations/ })
    .click()
  await page.getByRole("button", { name: "Refresh renewal queue" }).click()
  const reminders = page.getByRole("region", { name: "Daily renewal queue" })
  await expect(reminders.getByRole("alert")).toContainText("session expired")
  await expect(
    reminders.getByRole("button", { name: "Check reminders now" })
  ).toBeDisabled()
  await page.goto(`${origin}/account`)
  await page
    .getByRole("button", { name: "Request extension", exact: true })
    .click()
  await page.route("**/api/account/subscription", (route) =>
    route.fulfill({
      status: 401,
      contentType: "text/plain",
      body: "Unauthorized",
    })
  )
  await page
    .getByRole("button", { name: "Submit request", exact: true })
    .click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "session expired"
  )
  await expect(
    page.getByRole("button", { name: "Submit request", exact: true })
  ).toBeDisabled()
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
