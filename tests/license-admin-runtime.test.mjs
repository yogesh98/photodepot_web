import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { sealData, unsealData } from "iron-session"
import { parseCloudflareConfig } from "../scripts/cloudflare-config.mjs"

const repository = fileURLToPath(new URL("../", import.meta.url))
const origin = "https://photodepot.app"
const issuer = "https://api.workos.com"
const clientId = "client_test_admin"
const organizationId = "org_test_admin"
const cookiePassword = "runtime-test-cookie-password-at-least-32-characters"
const adminEmail = "yogesh.patel0221@gmail.com"
const userId = "user_test_admin"
const sessionId = "session_test_admin"
const jwksUrl = `${issuer}/sso/jwks/${clientId}`
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const vendor = generateKeyPairSync("ed25519")
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "runtime-test-key",
  alg: "RS256",
  use: "sig",
}
const config = parseCloudflareConfig(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
)
let outputDirectory

before(async () => {
  const temporaryRoot = join(repository, ".wrangler")
  await mkdir(temporaryRoot, { recursive: true })
  outputDirectory = await mkdtemp(join(temporaryRoot, "license-runtime-test-"))
  const wrangler = fileURLToPath(
    new URL("./bin/wrangler.js", import.meta.resolve("wrangler/package.json"))
  )
  // Execute the deployment bundle in workerd: Node fetch mocks do not enforce
  // Workers' supported Request options (including redirect modes).
  await promisify(execFile)(
    process.execPath,
    [
      wrangler,
      "pages",
      "functions",
      "build",
      "--outdir",
      outputDirectory,
      "--compatibility-date",
      config.compatibility_date,
      "--compatibility-flags",
      ...config.compatibility_flags,
    ],
    {
      cwd: repository,
      env: { ...process.env, WRANGLER_LOG_PATH: join(outputDirectory, "logs") },
    }
  )
})

after(async () => {
  if (outputDirectory)
    await rm(outputDirectory, { recursive: true, force: true })
})

function jwt(changes = {}, key = rsa.privateKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      client_id: clientId,
      org_id: organizationId,
      role: "owner",
      sub: userId,
      sid: sessionId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      ...changes,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`
}

async function sessionCookie(
  token = jwt(),
  changes = {},
  password = cookiePassword
) {
  const sealed = await sealData(
    {
      version: 1,
      clientId,
      origin,
      accessToken: token,
      refreshToken: "runtime-refresh-token",
      user: { id: userId, email: adminEmail, emailVerified: true },
      ...changes,
    },
    { password, ttl: 604800 }
  )
  return `__Host-photodepot-admin=${sealed}`
}

function runtime(
  t,
  outboundService,
  assets = () => new Response("dashboard"),
  bindings = {}
) {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      scriptPath: join(outputDirectory, "index.js"),
      modules: true,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      d1Databases: { DB: "license-runtime-test" },
      bindings: {
        WORKOS_CLIENT_ID: clientId,
        WORKOS_ADMIN_ORGANIZATION_ID: organizationId,
        WORKOS_COOKIE_PASSWORD: cookiePassword,
        WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
        PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64"),
        ...bindings,
      },
      outboundService,
      serviceBindings: { ASSETS: assets },
    })
  )
  t.after(() => worker.dispose())
  return worker
}

test("the built Pages Worker admits a signed administrator and retires legacy key issuance", async (t) => {
  const certificateRequests = []
  const worker = runtime(t, (request) => {
    certificateRequests.push(request.url)
    return Response.json({ keys: [jwk] })
  })
  const database = await worker.getD1Database("DB")
  const migration = await readFile(
    new URL("../migrations/0002_licenses.sql", import.meta.url),
    "utf8"
  )
  await database.batch(
    unstable_splitSqlQuery(migration).map((sql) => database.prepare(sql))
  )
  const headers = { cookie: await sessionCookie() }
  const shell = await worker.dispatchFetch(`${origin}/admin/licenses`, {
    headers,
  })
  assert.equal(shell.status, 200)
  assert.equal(await shell.text(), "dashboard")
  assert.equal(shell.headers.get("cache-control"), "private, no-store")
  // Native form POSTs under no-referrer send Origin:null and cannot pass our
  // strict CSRF check. Keep the document policy compatible with same-origin forms.
  assert.equal(shell.headers.get("referrer-policy"), "same-origin")
  const granted = await worker.dispatchFetch(`${origin}/api/admin/licenses`, {
    method: "POST",
    headers: { ...headers, origin, "content-type": "application/json" },
    body: JSON.stringify({
      action: "grant",
      type: "trial",
      customerName: "Runtime Tester",
      email: "tester@example.com",
      notes: "",
    }),
  })
  assert.equal(granted.status, 410)
  const result = await granted.json()
  assert.equal(result.code, "update_required")
  assert.deepEqual(certificateRequests, [jwksUrl])
  const anonymous = await worker.dispatchFetch(`${origin}/admin/licenses`, {
    redirect: "manual",
  })
  assert.equal(anonymous.status, 302)
  assert.equal(
    new URL(anonymous.headers.get("location"), origin).pathname,
    "/api/auth/login"
  )
})

test("the built Pages Worker rejects redirected certificates without following them", async (t) => {
  const certificateRequests = []
  let servedShell = false
  const worker = runtime(
    t,
    (request) => {
      certificateRequests.push(request.url)
      return request.url === jwksUrl
        ? new Response(null, {
            status: 302,
            headers: { Location: "https://redirected.example/certs" },
          })
        : Response.json({ keys: [jwk] })
    },
    () => {
      servedShell = true
      return new Response("dashboard")
    }
  )
  for (const path of ["/admin/licenses", "/api/admin/licenses"]) {
    const response = await worker.dispatchFetch(`${origin}${path}`, {
      headers: { cookie: await sessionCookie() },
    })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  assert.equal(servedShell, false)
  assert.deepEqual(certificateRequests, [jwksUrl, jwksUrl])
})

test("the built Pages Worker enforces organization-scoped Owner authorization on shell and API", async (t) => {
  let servedShell = false
  const worker = runtime(
    t,
    () => Response.json({ keys: [jwk] }),
    () => {
      servedShell = true
      return new Response("dashboard")
    }
  )
  for (const claims of [
    { role: "member" },
    { org_id: "org_other" },
    { role: "Owner" },
    { role: "member", roles: ["org-owner"] },
  ]) {
    for (const path of [
      "/admin",
      "/admin/",
      "/admin.html",
      "/admin.txt",
      "/admin/__next._full.txt",
      "/admin/licenses",
      "/admin/subscriptions",
      "/admin/subscriptions.html",
      "/admin/subscriptions.txt",
      "/api/admin/licenses",
      "/api/admin/subscriptions",
      "/api/admin/subscriptions?history=1&userId=user_runtime_customer",
    ]) {
      const response = await worker.dispatchFetch(`${origin}${path}`, {
        headers: { cookie: await sessionCookie(jwt(claims)) },
      })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
    }
  }
  assert.equal(servedShell, false)
  const owner = await worker.dispatchFetch(`${origin}/admin/licenses`, {
    headers: {
      cookie: await sessionCookie(
        jwt({ role: "member", roles: ["member", "owner"] })
      ),
    },
  })
  assert.equal(owner.status, 200)
  assert.equal(servedShell, true)
})

test("the built Pages Worker authorizes subscription administration only for a verified Owner", async (t) => {
  let customerRequests = 0
  const customer = {
    object: "user",
    id: "user_runtime_customer",
    email: "customer@example.test",
    email_verified: true,
    first_name: "Runtime",
    last_name: "Customer",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const worker = runtime(
    t,
    (request) => {
      if (request.url === jwksUrl) return Response.json({ keys: [jwk] })
      assert.equal(
        request.headers.get("authorization"),
        "Bearer sk_test_runtime"
      )
      customerRequests++
      if (new URL(request.url).pathname === "/user_management/users")
        return Response.json({
          data: [customer],
          list_metadata: { before: null, after: null },
        })
      assert.equal(
        request.url,
        `${issuer}/user_management/users/${customer.id}`
      )
      return Response.json(customer)
    },
    undefined,
    { WORKOS_API_KEY: "sk_test_runtime" }
  )
  const database = await worker.getD1Database("DB")
  for (const filename of (
    await readdir(new URL("../migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const migration = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8"
    )
    await database.batch(
      unstable_splitSqlQuery(migration).map((sql) => database.prepare(sql))
    )
  }
  const denied = [
    [undefined, 401],
    [await sessionCookie(jwt({ role: "member" })), 403],
    [await sessionCookie(jwt({ org_id: "org_other" })), 403],
    [await sessionCookie(jwt(), { audience: "account" }), 401],
    [
      await sessionCookie(jwt(), {
        user: { id: userId, email: adminEmail, emailVerified: false },
      }),
      401,
    ],
  ]
  for (const [cookie, status] of denied) {
    for (const action of [
      "set",
      "extend",
      "revoke",
      "restore",
      "reset-device",
    ]) {
      const response = await worker.dispatchFetch(
        `${origin}/api/admin/subscriptions`,
        {
          method: "POST",
          headers: {
            ...(cookie ? { cookie } : {}),
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action,
            userId: customer.id,
            type: "trial",
            durationDays: 14,
            expectedRevision: 0,
          }),
        }
      )
      assert.equal(response.status, status)
    }
  }
  assert.equal(customerRequests, 0)
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM subscriptions")
        .first()
    ).count,
    0
  )
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM subscription_audit")
        .first()
    ).count,
    0
  )

  const headers = {
    cookie: await sessionCookie(),
    origin,
    "content-type": "application/json",
  }
  const granted = await worker.dispatchFetch(
    `${origin}/api/admin/subscriptions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set",
        userId: customer.id,
        type: "trial",
        durationDays: 14,
        expectedRevision: 0,
      }),
    }
  )
  assert.equal(granted.status, 410)
  assert.match((await granted.json()).error, /retired/)
  const listed = await worker.dispatchFetch(
    `${origin}/api/admin/subscriptions`,
    { headers }
  )
  assert.equal(listed.status, 200)
  assert.equal((await listed.json()).users[0].subscription, null)
  assert.equal(customerRequests, 1)
})

test("the built Pages Worker denies subscription administration after Owner membership is removed", async (t) => {
  let servedShell = false
  const worker = runtime(
    t,
    async (request) => {
      if (request.url === jwksUrl) return Response.json({ keys: [jwk] })
      assert.equal(request.url, `${issuer}/user_management/authenticate`)
      const body = await request.json()
      assert.equal(body.organization_id, organizationId)
      return Response.json({
        access_token: jwt({ role: "member" }),
        refresh_token: "runtime-demoted-refresh-token",
        user: {
          object: "user",
          id: userId,
          email: adminEmail,
          email_verified: true,
        },
      })
    },
    () => {
      servedShell = true
      return new Response("dashboard")
    }
  )
  for (const path of [
    "/admin",
    "/admin.html",
    "/admin.txt",
    "/admin/subscriptions",
    "/api/admin/subscriptions",
  ]) {
    const response = await worker.dispatchFetch(`${origin}${path}`, {
      headers: { cookie: await sessionCookie(jwt({ exp: 1 })) },
    })
    assert.equal(response.status, 403)
  }
  assert.equal(servedShell, false)
})

test("the built Pages Worker rejects forged sessions and legacy Cloudflare authentication", async (t) => {
  const foreignKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const worker = runtime(t, () => Response.json({ keys: [jwk] }))
  const cookies = [
    "__Host-photodepot-admin=forged",
    await sessionCookie(
      jwt(),
      {},
      "wrong-cookie-password-at-least-32-characters"
    ),
    await sessionCookie(jwt({}, foreignKey.privateKey)),
    await sessionCookie(jwt({ client_id: "client_other" })),
    await sessionCookie(jwt({ iss: "https://attacker.example" })),
    await sessionCookie(jwt({ sub: "user_other" })),
    await sessionCookie(jwt(), { origin: "https://attacker.example" }),
    await sessionCookie(jwt(), { audience: "account" }),
    await sessionCookie(jwt(), {
      user: { id: userId, email: adminEmail, emailVerified: false },
    }),
  ]
  for (const cookie of cookies) {
    for (const path of ["/api/admin/licenses", "/api/admin/subscriptions"]) {
      const response = await worker.dispatchFetch(`${origin}${path}`, {
        headers: { cookie },
      })
      assert.equal(response.status, 401)
    }
  }
  const legacyHeaders = {
    "cf-access-jwt-assertion": jwt(),
    "cf-access-authenticated-user-email": adminEmail,
  }
  const legacyApi = await worker.dispatchFetch(`${origin}/api/admin/licenses`, {
    headers: legacyHeaders,
  })
  assert.equal(legacyApi.status, 401)
  const legacyShell = await worker.dispatchFetch(
    `${origin}/admin/licenses.html`,
    { headers: legacyHeaders, redirect: "manual" }
  )
  assert.equal(legacyShell.status, 302)
})

test("the built Pages Worker fails closed when WorkOS session configuration is missing", async (t) => {
  let outboundRequests = 0
  let servedShell = false
  const worker = runtime(
    t,
    () => {
      outboundRequests++
      return Response.json({ keys: [jwk] })
    },
    () => {
      servedShell = true
      return new Response("dashboard")
    },
    { WORKOS_COOKIE_PASSWORD: "" }
  )
  for (const path of [
    "/admin",
    "/admin.html",
    "/admin.txt",
    "/admin/licenses",
    "/admin/subscriptions",
    "/api/admin/licenses",
    "/api/admin/subscriptions",
  ]) {
    assert.equal((await worker.dispatchFetch(`${origin}${path}`)).status, 503)
  }
  assert.equal(outboundRequests, 0)
  assert.equal(servedShell, false)
})

test("the built Pages Worker rejects cross-origin admin mutations", async (t) => {
  const worker = runtime(t, () => Response.json({ keys: [jwk] }))
  for (const requestOrigin of ["https://attacker.example", "null", ""]) {
    for (const path of ["/api/admin/licenses", "/api/admin/subscriptions"]) {
      const response = await worker.dispatchFetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          cookie: await sessionCookie(),
          origin: requestOrigin,
          referer: `${origin}/admin/licenses`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "grant" }),
      })
      assert.equal(response.status, 403)
    }
  }
})

test("the built Pages Worker refreshes an expired owner session without a WorkOS API key", async (t) => {
  const requests = []
  const token = jwt()
  const worker = runtime(t, async (request) => {
    requests.push(request.url)
    if (request.url === jwksUrl) return Response.json({ keys: [jwk] })
    assert.equal(request.url, `${issuer}/user_management/authenticate`)
    assert.equal(request.method, "POST")
    const body = await request.json()
    assert.equal(body.client_id, clientId)
    assert.equal(body.grant_type, "refresh_token")
    assert.equal(body.refresh_token, "runtime-refresh-token")
    assert.equal(body.organization_id, organizationId)
    assert.equal("client_secret" in body, false)
    return Response.json({
      access_token: token,
      refresh_token: "runtime-rotated-refresh-token",
      organization_id: organizationId,
      user: {
        object: "user",
        id: userId,
        email: adminEmail,
        email_verified: true,
      },
    })
  })
  const response = await worker.dispatchFetch(`${origin}/admin/licenses`, {
    headers: { cookie: await sessionCookie(jwt({ exp: 1 })) },
  })
  assert.equal(response.status, 200)
  const setCookie = response.headers.get("set-cookie")
  assert.match(setCookie, /^__Host-photodepot-admin=/)
  assert.match(setCookie, /Secure/i)
  assert.match(setCookie, /HttpOnly/i)
  const value = setCookie.split(";")[0].slice("__Host-photodepot-admin=".length)
  const session = await unsealData(value, {
    password: cookiePassword,
    ttl: 604800,
  })
  assert.equal(session.accessToken, token)
  assert.equal(session.refreshToken, "runtime-rotated-refresh-token")
  assert.ok(requests.includes(`${issuer}/user_management/authenticate`))
})

test("the built Pages Worker preserves sessions during WorkOS key and refresh outages", async (t) => {
  let servedShell = false
  const unavailableKeys = runtime(
    t,
    () => new Response(null, { status: 503 }),
    () => {
      servedShell = true
      return new Response("dashboard")
    }
  )
  const keyFailure = await unavailableKeys.dispatchFetch(
    `${origin}/admin/licenses`,
    {
      headers: { cookie: await sessionCookie() },
    }
  )
  assert.equal(keyFailure.status, 503)
  assert.equal(keyFailure.headers.get("set-cookie"), null)
  assert.equal(servedShell, false)

  const unavailableRefresh = runtime(t, (request) => {
    return request.url === jwksUrl
      ? Response.json({ keys: [jwk] })
      : new Response(null, { status: 503 })
  })
  const refreshFailure = await unavailableRefresh.dispatchFetch(
    `${origin}/api/admin/licenses`,
    {
      headers: { cookie: await sessionCookie(jwt({ exp: 1 })) },
    }
  )
  assert.equal(refreshFailure.status, 503)
  assert.equal(refreshFailure.headers.get("set-cookie"), null)
})

test("the built Pages Worker returns dashboard access for the selected signed-in identity", async (t) => {
  let activeOwner = true
  const worker = runtime(
    t,
    (request) => {
      if (request.url === jwksUrl) return Response.json({ keys: [jwk] })
      const url = new URL(request.url)
      assert.equal(url.pathname, "/user_management/organization_memberships")
      assert.equal(url.searchParams.get("user_id"), userId)
      assert.equal(url.searchParams.get("organization_id"), organizationId)
      assert.equal(url.searchParams.get("statuses"), "active")
      assert.equal(
        request.headers.get("authorization"),
        "Bearer sk_test_runtime_membership"
      )
      return Response.json({
        data: activeOwner
          ? [
              {
                object: "organization_membership",
                id: "om_runtime_test",
                organization_id: organizationId,
                organization_name: "Photodepot Administration",
                user_id: userId,
                status: "active",
                role: { slug: "owner" },
              },
            ]
          : [],
        list_metadata: { before: null, after: null },
      })
    },
    undefined,
    { WORKOS_API_KEY: "sk_test_runtime_membership" }
  )
  const accountCookie = (
    await sessionCookie(jwt({ org_id: undefined, role: undefined }), {
      audience: "account",
    })
  ).replace("__Host-photodepot-admin=", "__Host-photodepot-account=")
  const cookie = `${accountCookie}; ${await sessionCookie()}`
  for (const dashboard of ["individual", "admin"]) {
    const response = await worker.dispatchFetch(
      `${origin}/api/account/dashboard-access?dashboard=${dashboard}`,
      { headers: { cookie } }
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      user: { id: userId, email: adminEmail },
      canAccessAdmin: true,
    })
    assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  activeOwner = false
  const removed = await worker.dispatchFetch(
    `${origin}/api/account/dashboard-access?dashboard=individual`,
    { headers: { cookie } }
  )
  assert.deepEqual(await removed.json(), {
    user: { id: userId, email: adminEmail },
    canAccessAdmin: false,
  })
})
