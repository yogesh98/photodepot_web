import assert from "node:assert/strict"
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { createServer } from "node:http"
import { after, before, test } from "node:test"
import { sealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAccountApproval } from "../lib/account-pairing.ts"
import { listAccountDevices } from "../lib/account-sessions.ts"

const { chromium } = await import(
  process.env.PHOTODEPOT_TEST_PLAYWRIGHT_MODULE || "@playwright/test"
)
const clientId = "client_auto_signin_browser"
const password = "auto-signin-browser-password-at-least-32-characters"
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "auto-signin-key",
  alg: "RS256",
  use: "sig",
}
const vendor = generateKeyPairSync("ed25519")
let platform, env, server, browser, origin, originalFetch
const hash = (value) => createHash("sha256").update(value).digest("hex")
const requests = []

before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((value) => value.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8"
    )
    await platform.env.DB.batch(
      unstable_splitSqlQuery(sql).map((value) => platform.env.DB.prepare(value))
    )
  }
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    const userId = new URL(url).pathname.split("/").at(-1)
    assert.match(userId, /^user_browser_/)
    return Response.json({
      id: userId,
      email: `${userId}@example.test`,
      email_verified: true,
    })
  }
  server = createServer(async (incoming, outgoing) => {
    try {
      const bytes = []
      for await (const chunk of incoming) bytes.push(chunk)
      const url = new URL(incoming.url, origin)
      requests.push({
        method: incoming.method,
        path: url.pathname,
        origin: incoming.headers.origin,
      })
      let response
      if (url.pathname === "/brand/photodepot-lockup.svg")
        response = new Response(
          await readFile(
            new URL("../public/brand/photodepot-lockup.svg", import.meta.url)
          ),
          { headers: { "content-type": "image/svg+xml" } }
        )
      else
        response = await handleAccountApproval(
          new Request(url, {
            method: incoming.method,
            headers: incoming.headers,
            ...(bytes.length ? { body: Buffer.concat(bytes) } : {}),
          }),
          env
        )
      outgoing.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        "set-cookie": response.headers.getSetCookie(),
      })
      outgoing.end(await response.text())
    } catch (error) {
      outgoing.writeHead(500)
      outgoing.end(String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  env = {
    ...platform.env,
    WORKOS_CLIENT_ID: clientId,
    WORKOS_COOKIE_PASSWORD: password,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    WORKOS_API_KEY: "sk_browser_test",
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  }
  browser = await chromium.launch({
    channel: process.env.PHOTODEPOT_TEST_BROWSER_CHANNEL || undefined,
  })
})
after(async () => {
  globalThis.fetch = originalFetch
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
  await platform?.dispose()
})

async function browserPage(t, userId, javaScriptEnabled = true) {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: userId,
      sid: `session_${userId}`,
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url")
  const jwt = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
  const cookie = await sealData(
    {
      version: 1,
      audience: "account",
      clientId,
      origin,
      accessToken: jwt,
      refreshToken: "browser-refresh",
      user: {
        id: userId,
        email: `${userId}@example.test`,
        emailVerified: true,
      },
    },
    { password, ttl: 604800 }
  )
  const context = await browser.newContext({
    viewport: { width: 1000, height: 850 },
    javaScriptEnabled,
  })
  t.after(() => context.close())
  await context.addCookies([
    {
      name: "photodepot-account",
      value: cookie,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ])
  await context.route("https://**/*", (route) => route.abort())
  return { context, page: await context.newPage() }
}
async function pending(name) {
  const code = randomBytes(32).toString("base64url")
  const deviceId = randomBytes(32).toString("hex")
  await env.DB.prepare(
    "INSERT INTO account_pairings (token_hash,code_hash,device_id,public_key,challenge,created_at,expires_at,account_version,intent,device_name) VALUES (?,?,?,?,?,?,?,1,'login',?)"
  )
    .bind(
      hash(randomBytes(32).toString("base64url")),
      hash(code),
      deviceId,
      "browser-public-key",
      randomBytes(32).toString("base64url"),
      Date.now(),
      Date.now() + 600_000,
      name
    )
    .run()
  return { url: `${origin}/account/activate?code=${code}`, deviceId }
}
async function connected(userId, name, lastUsedAt) {
  const id = randomUUID(),
    deviceId = randomBytes(32).toString("hex")
  await env.DB.prepare(
    "INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,created_at,updated_at,device_name,last_used_at) VALUES (?,?,?,?,?,?,?,?,?)"
  )
    .bind(
      id,
      deviceId,
      userId,
      `${userId}@example.test`,
      "browser-public-key",
      Date.now() - 86_400_000,
      Date.now(),
      name,
      lastUsedAt
    )
    .run()
  return { id, deviceId }
}

test("browser auto-submits a free-slot sign-in and renders branded success", async (t) => {
  const userId = "user_browser_auto"
  const started = await pending("Yogesh’s MacBook Pro")
  const { page } = await browserPage(t, userId)
  await page.goto(started.url)
  await page.getByRole("heading", { name: "Signed in", exact: true }).waitFor()
  assert.equal(
    await page.getByText("Return to Photodepot.", { exact: true }).count(),
    1
  )
  assert.equal(await page.getByRole("img", { name: "Photodepot" }).count(), 1)
  assert.ok(
    requests.some((value) => value.method === "POST" && value.origin === origin)
  )
  const devices = await listAccountDevices(env.DB, userId)
  assert.equal(devices[0].deviceName, "Yogesh’s MacBook Pro")
  await page.screenshot({
    path: "/tmp/photodepot-auth-success.png",
    fullPage: true,
  })
})

test("browser shows two named computers and removes only the chosen computer while signing in", async (t) => {
  const userId = "user_browser_picker"
  const first = await connected(
    userId,
    "Studio Mac mini",
    Date.now() - 3_600_000
  )
  const second = await connected(
    userId,
    "Yogesh’s MacBook Pro",
    Date.now() - 300_000
  )
  const started = await pending("Travel MacBook Air")
  const { page } = await browserPage(t, userId)
  await page.goto(started.url)
  await page
    .getByRole("heading", { name: "Choose a computer to sign out" })
    .waitFor()
  assert.equal(await page.getByRole("radio").count(), 2)
  assert.equal(
    await page.getByText("Studio Mac mini", { exact: true }).count(),
    1
  )
  assert.equal(
    await page.getByText("Yogesh’s MacBook Pro", { exact: true }).count(),
    1
  )
  assert.equal(await page.getByText(/Last used/).count(), 2)
  assert.equal((await listAccountDevices(env.DB, userId)).length, 2)
  await page.screenshot({
    path: "/tmp/photodepot-auth-computer-picker.png",
    fullPage: true,
  })
  await page.getByRole("radio").first().check()
  await page
    .getByRole("button", { name: "Remove and sign in", exact: true })
    .click()
  await page.getByRole("heading", { name: "Signed in", exact: true }).waitFor()
  const devices = await listAccountDevices(env.DB, userId)
  assert.ok(!devices.some((value) => value.id === first.deviceId))
  assert.ok(devices.some((value) => value.id === second.deviceId))
  assert.ok(devices.some((value) => value.id === started.deviceId))
})

test("browser without JavaScript has a Continue fallback and never admits on GET", async (t) => {
  const userId = "user_browser_nojs"
  const started = await pending("Offline test computer")
  const { page } = await browserPage(t, userId, false)
  await page.goto(started.url)
  assert.deepEqual(await listAccountDevices(env.DB, userId), [])
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  await page.getByRole("heading", { name: "Signed in", exact: true }).waitFor()
  assert.equal((await listAccountDevices(env.DB, userId)).length, 1)
})

test("a foreign top-level link requires explicit computer continuation and cannot auto-sign in", async (t) => {
  const userId = "user_browser_foreign"
  const started = await pending("Untrusted link computer")
  const { context, page } = await browserPage(t, userId)
  await context.route("http://foreign.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<a href="${started.url}">Open sign-in</a>`,
    })
  )
  await page.goto("http://foreign.test/")
  await page.getByRole("link", { name: "Open sign-in" }).click()
  await page
    .getByRole("heading", { name: "Continue signing in", exact: true })
    .waitFor()
  assert.equal(
    await page.getByText("Untrusted link computer", { exact: true }).count(),
    1
  )
  assert.equal(
    await page.getByRole("button", { name: "Continue", exact: true }).count(),
    1
  )
  assert.deepEqual(await listAccountDevices(env.DB, userId), [])
})

test("native initiation keeps automatic sign-in through a hosted cross-site return", async (t) => {
  const userId = "user_browser_hosted_return"
  const started = await pending("Native initiated computer")
  const { context, page } = await browserPage(t, userId)
  const account = (await context.cookies()).find(
    (value) => value.name === "photodepot-account"
  )
  await context.clearCookies({ name: "photodepot-account" })
  const initial = await context.request.get(started.url, {
    headers: { "sec-fetch-site": "none" },
    maxRedirects: 0,
  })
  assert.equal(initial.status(), 302)
  assert.ok(
    (await context.cookies()).some(
      (value) => value.name === "photodepot-device-intent" && value.httpOnly
    )
  )
  await context.addCookies([account])
  await context.route("http://hosted-auth.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<a href="${started.url}">Return from authentication</a>`,
    })
  )
  await page.goto("http://hosted-auth.test/")
  await page.getByRole("link", { name: "Return from authentication" }).click()
  await page.getByRole("heading", { name: "Signed in", exact: true }).waitFor()
  assert.equal((await listAccountDevices(env.DB, userId)).length, 1)
})
