import assert from "node:assert/strict"
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, test } from "node:test"
import { sealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import {
  handleAccountApproval,
  handleAccountPairing,
} from "../lib/account-pairing.ts"
import { getSubscription, setSubscription } from "../lib/subscription-store.ts"
import {
  handleDesktopSession,
  listAccountDevices,
} from "../lib/account-sessions.ts"
import { handleAccountSubscription } from "../functions/api/account/subscription.ts"
import { handleLicenseRequest } from "../lib/license-api.ts"
import { workosBillingConfiguration } from "../lib/workos-entitlements.ts"

const origin = "https://photodepot.app"
const clientId = "client_pairing_tests"
const cookiePassword =
  "account-pairing-tests-cookie-password-at-least-32-characters"
const epoch = Date.now()
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const vendor = generateKeyPairSync("ed25519")
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "pairing-test-key",
  alg: "RS256",
  use: "sig",
}
const users = new Map()
let platform, env, originalFetch
let sequence = 0

before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = {
    ...platform.env,
    WORKOS_CLIENT_ID: clientId,
    WORKOS_BILLING_CLIENT_ID: "client_billing_pairing_tests",
    WORKOS_ADMIN_ORGANIZATION_ID: "org_pairing_admin",
    WORKOS_COOKIE_PASSWORD: cookiePassword,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    WORKOS_API_KEY: "sk_test_account_pairing",
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: vendor.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  }
  for (const filename of (
    await readdir(new URL("../migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const source = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8"
    )
    await env.DB.batch(
      unstable_splitSqlQuery(source).map((sql) => env.DB.prepare(sql))
    )
  }
  originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url) === `https://api.workos.com/sso/jwks/${clientId}`) {
      assert.equal(options.redirect, "manual")
      return Response.json({ keys: [jwk] })
    }
    assert.match(
      String(url),
      /^https:\/\/api\.workos\.com\/user_management\/users\/user_[A-Za-z0-9_]+$/
    )
    assert.equal(
      new Headers(options.headers).get("authorization"),
      `Bearer ${env.WORKOS_API_KEY}`
    )
    const userId = new URL(url).pathname.split("/").at(-1)
    const user = users.get(userId)
    if (user === "unavailable")
      return Response.json({ message: "Service unavailable" }, { status: 503 })
    if (!user)
      return Response.json({ message: "User not found" }, { status: 404 })
    return Response.json({
      object: "user",
      id: userId,
      email: user.email,
      email_verified: user.emailVerified,
      first_name: "Customer",
      last_name: "Tester",
      created_at: new Date(epoch).toISOString(),
      updated_at: new Date(epoch).toISOString(),
    })
  }
})

after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})

function mac() {
  const pair = generateKeyPairSync("ed25519")
  const bytes = pair.publicKey.export({ format: "der", type: "spki" })
  return {
    ...pair,
    deviceId: createHash("sha256").update(bytes).digest("hex"),
    publicKeyEncoded: bytes.toString("base64url"),
    challenge: randomBytes(32).toString("base64url"),
  }
}

function jwt(userId, sessionId = `session_${userId}`) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  // Customer login needs no membership in the administration organization.
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: userId,
      sid: sessionId,
      iat: Math.floor(epoch / 1000),
      exp: Math.floor(epoch / 1000) + 3600,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}

async function accountCookie(userId, audience = "account", sessionId) {
  const value = await sealData(
    {
      version: 1,
      audience,
      clientId,
      origin,
      accessToken: jwt(userId, sessionId),
      refreshToken: `refresh_${userId}`,
      user: {
        id: userId,
        email: users.get(userId)?.email ?? `${userId}@example.com`,
        emailVerified: true,
      },
    },
    { password: cookiePassword, ttl: 604800 }
  )
  return `__Host-photodepot-account=${value}`
}

async function assign(userId, type = "trial", endsAt = epoch + 60 * 60 * 1000) {
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  return setSubscription(
    env.DB,
    { userId, type, endsAt, expectedRevision: 0 },
    "owner@example.com",
    epoch
  )
}

function signedBody(device, action, pairingId, changes = {}) {
  const parts =
    action === "start"
      ? [
          "photodepot-account-pairing-v1",
          "start",
          device.deviceId,
          device.publicKeyEncoded,
          device.challenge,
          ...(device.deviceName === undefined ? [] : [device.deviceName]),
        ]
      : [
          "photodepot-account-pairing-v1",
          action,
          pairingId,
          device.deviceId,
          device.challenge,
        ]
  return {
    deviceId: device.deviceId,
    challenge: device.challenge,
    ...(action === "start"
      ? {
          devicePublicKey: device.publicKeyEncoded,
          ...(device.deviceName === undefined
            ? {}
            : { deviceName: device.deviceName }),
        }
      : { pairingId }),
    deviceSignature: sign(
      null,
      Buffer.from(JSON.stringify(parts)),
      device.privateKey
    ).toString("base64url"),
    ...changes,
  }
}

function pair(
  device,
  action = "start",
  pairingId,
  changes = {},
  bindings = env,
  hostname = origin,
  headers = {}
) {
  return handleAccountPairing(
    new Request(`${hostname}/api/account/pairing/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Photodepot-Account-Version": "1",
        "cf-connecting-ip": `pairing-test-${sequence++}`,
        ...headers,
      },
      body: JSON.stringify(signedBody(device, action, pairingId, changes)),
    }),
    bindings,
    action
  )
}

async function approval(
  started,
  userId,
  method = "POST",
  headers = {},
  hostname = origin
) {
  const target = new URL(started.approvalUrl)
  const cookie = userId ? await accountCookie(userId) : undefined
  let body
  if (started.account && method === "POST" && cookie) {
    const preview = await handleAccountApproval(
      new Request(`${hostname}${target.pathname}${target.search}`, {
        headers: { cookie },
      }),
      env
    )
    const html = await preview.text()
    const token = html.match(/name="csrf" value="([^"]+)"/)?.[1]
    body = new URLSearchParams({ csrf: token ?? "" })
  }
  return handleAccountApproval(
    new Request(`${hostname}${target.pathname}${target.search}`, {
      method,
      headers: {
        origin: hostname,
        ...(cookie ? { cookie } : {}),
        ...(body
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...headers,
      },
      ...(body ? { body } : {}),
    }),
    env
  )
}

function decodeReceipt(envelope) {
  const bytes = Buffer.from(envelope.payload, "base64url")
  assert.ok(
    verify(
      null,
      bytes,
      vendor.publicKey,
      Buffer.from(envelope.signature, "base64url")
    )
  )
  return JSON.parse(bytes.toString("utf8"))
}

async function accountStart(device = mac()) {
  const response = await pair(device, "start", undefined, {}, env, origin, {
    "Photodepot-Account-Version": "1",
  })
  assert.equal(response.status, 201)
  return { ...(await response.json()), device, account: true }
}
async function accountPoll(started) {
  return pair(started.device, "poll", started.pairingId, {}, env, origin, {
    "Photodepot-Account-Version": "1",
  })
}
function sessionRequest(
  device,
  sessionId,
  action = "verify",
  changes = {},
  bindings = env
) {
  const challenge = randomBytes(32).toString("base64url")
  return handleDesktopSession(
    new Request(`${origin}/api/account/session/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `session-test-${sequence++}`,
      },
      body: JSON.stringify({
        sessionId,
        deviceId: device.deviceId,
        challenge,
        deviceSignature: sign(
          null,
          Buffer.from(
            JSON.stringify([
              "photodepot-account-session-v1",
              action,
              sessionId,
              device.deviceId,
              challenge,
              ...(changes.deviceName === undefined ? [] : [changes.deviceName]),
            ])
          ),
          device.privateKey
        ).toString("base64url"),
        ...changes,
      }),
    }),
    bindings,
    action
  )
}
async function accountLogin(userId, device = mac()) {
  if (!users.has(userId))
    users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  const started = await accountStart(device)
  assert.equal((await approval(started, userId)).status, 200)
  const response = await accountPoll(started)
  assert.equal(response.status, 200)
  const result = await response.json()
  return { ...started, result, claims: decodeReceipt(result.session) }
}

test("account sessions allow collaboration without subscriptions and expose independent signed login claims", async () => {
  const userId = "user_session_free"
  const loggedIn = await accountLogin(userId)
  assert.equal(loggedIn.result.status, "approved")
  assert.equal("receipt" in loggedIn.result, false)
  assert.equal(loggedIn.claims.userId, userId)
  assert.equal(loggedIn.claims.status, "active")
  assert.equal(loggedIn.claims.deviceId, loggedIn.device.deviceId)
  assert.equal(
    loggedIn.claims.expiresAt - loggedIn.claims.issuedAt,
    48 * 60 * 60 * 1000
  )
  assert.equal(await getSubscription(env.DB, userId), null)
  const verified = await sessionRequest(
    loggedIn.device,
    loggedIn.claims.sessionId
  )
  assert.equal(verified.status, 200)
  const result = await verified.json()
  assert.equal(decodeReceipt(result.session).status, "active")
  assert.equal("receipt" in result, false)
  assert.equal((await listAccountDevices(env.DB, userId)).length, 1)
})

test("subscription withdrawal removes local entitlement while keeping the account session active", async () => {
  const userId = "user_session_entitlement",
    now = Date.now()
  await assign(userId, "regular", now + 30 * 86_400_000)
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO stripe_customers (user_id,stripe_customer_id,workos_organization_id,customer_create_token) VALUES (?,?,?,?)"
    ).bind(
      userId,
      "cus_session_entitlement",
      "org_session_entitlement",
      "fixture"
    ),
    env.DB.prepare(
      "INSERT INTO workos_billing_sessions (user_id,session_id,encrypted_tokens,updated_at) VALUES (?,?,?,?)"
    ).bind(userId, "billing_session_entitlement", "unused", now),
    env.DB.prepare(
      "INSERT INTO workos_entitlements (user_id,organization_id,enabled,issued_at,expires_at,revision,context) VALUES (?,?,1,?,?,1,?)"
    ).bind(
      userId,
      "org_session_entitlement",
      now,
      now + 300_000,
      workosBillingConfiguration(env).context
    ),
  ])
  const loggedIn = await accountLogin(userId)
  assert.equal(decodeReceipt(loggedIn.result.receipt).status, "active")
  assert.equal(
    decodeReceipt(loggedIn.result.receipt).challenge,
    loggedIn.claims.challenge
  )
  await env.DB.prepare(
    "UPDATE workos_entitlements SET enabled=0,revision=revision+1 WHERE user_id=?"
  )
    .bind(userId)
    .run()
  const result = await (
    await sessionRequest(loggedIn.device, loggedIn.claims.sessionId)
  ).json()
  assert.equal(decodeReceipt(result.session).status, "active")
  assert.equal("receipt" in result, false)
  assert.equal((await getSubscription(env.DB, userId)).status, "active")
})

test("desktop logout revokes its exact session and old proofs or pairing cannot revive it after a fresh login", async () => {
  const userId = "user_session_logout"
  const first = await accountLogin(userId)
  const response = await sessionRequest(
    first.device,
    first.claims.sessionId,
    "logout"
  )
  assert.equal(response.status, 200)
  const revoked = decodeReceipt((await response.json()).session)
  assert.equal(revoked.status, "revoked")
  assert.equal(revoked.revision, first.claims.revision + 1)
  assert.equal((await listAccountDevices(env.DB, userId)).length, 0)
  assert.equal((await accountPoll(first)).status, 410)
  const second = await accountLogin(userId, first.device)
  assert.notEqual(second.claims.sessionId, first.claims.sessionId)
  const old = await sessionRequest(first.device, first.claims.sessionId)
  assert.equal(decodeReceipt((await old.json()).session).status, "revoked")
  await sessionRequest(first.device, first.claims.sessionId, "logout")
  const current = await sessionRequest(first.device, second.claims.sessionId)
  assert.equal(decodeReceipt((await current.json()).session).status, "active")
  assert.equal((await listAccountDevices(env.DB, userId)).length, 1)
})

test("web Remove Mac revokes the same free-account session and protects other accounts and stale sessions", async () => {
  const userId = "user_session_console"
  const first = await accountLogin(userId)
  const cookie = await accountCookie(userId)
  const get = await handleAccountSubscription(
    new Request(`${origin}/api/account/subscription`, { headers: { cookie } }),
    env
  )
  const account = await get.json()
  assert.equal(account.access.status, "none")
  assert.equal(account.devices[0].sessionId, first.claims.sessionId)
  async function remove(asCookie, overrides = {}, requestOrigin = origin) {
    return handleAccountSubscription(
      new Request(`${origin}/api/account/subscription`, {
        method: "POST",
        headers: {
          cookie: asCookie,
          origin: requestOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "remove-device",
          deviceId: first.device.deviceId,
          sessionId: first.claims.sessionId,
          expectedSessionRevision: 1,
          ...overrides,
        }),
      }),
      env
    )
  }
  assert.equal(
    (await remove(cookie, {}, "https://attacker.example")).status,
    403
  )
  users.set("user_session_console_other", {
    email: "other@example.com",
    emailVerified: true,
  })
  assert.equal(
    (await remove(await accountCookie("user_session_console_other"))).status,
    409
  )
  assert.equal(
    (await remove(cookie, { expectedSessionRevision: 2 })).status,
    409
  )
  const removed = await remove(cookie)
  assert.equal(removed.status, 200)
  assert.deepEqual((await removed.json()).devices, [])
  const verified = await sessionRequest(first.device, first.claims.sessionId)
  assert.equal(decodeReceipt((await verified.json()).session).status, "revoked")
  assert.equal((await remove(cookie)).status, 409)
})

test("account session proofs are scoped to the exact device, action, challenge and session", async () => {
  const first = await accountLogin("user_session_proofs")
  const second = await accountLogin("user_session_proofs")
  for (const changes of [
    { deviceId: second.device.deviceId },
    { challenge: randomBytes(32).toString("base64url") },
    { sessionId: second.claims.sessionId },
    { deviceSignature: "a".repeat(86) },
  ])
    assert.equal(
      (
        await sessionRequest(
          first.device,
          first.claims.sessionId,
          "verify",
          changes
        )
      ).status,
      401
    )
  assert.equal(
    decodeReceipt(
      (
        await (
          await sessionRequest(first.device, first.claims.sessionId)
        ).json()
      ).session
    ).status,
    "active"
  )
})

test("deleted and unverified accounts revoke login while WorkOS outages preserve recoverable sessions", async () => {
  for (const state of ["deleted", "unverified", "unavailable"]) {
    const userId = `user_session_account_${state}`
    const first = await accountLogin(userId)
    if (state === "deleted") users.delete(userId)
    else if (state === "unverified")
      users.set(userId, {
        email: "unverified@example.com",
        emailVerified: false,
      })
    else users.set(userId, "unavailable")
    const response = await sessionRequest(first.device, first.claims.sessionId)
    assert.equal(response.status, state === "unavailable" ? 503 : 200)
    if (response.status === 200)
      assert.equal(
        decodeReceipt((await response.json()).session).status,
        "revoked"
      )
  }
})

test("cancelling a browser-approved sign-in revokes the session and frees its Mac slot", async () => {
  const first = await accountLogin("user_session_cancel")
  const cancelled = await pair(
    first.device,
    "cancel",
    first.pairingId,
    {},
    env,
    origin,
    { "Photodepot-Account-Version": "1" }
  )
  assert.equal(cancelled.status, 200)
  assert.equal(
    (await listAccountDevices(env.DB, first.claims.userId)).length,
    0
  )
  const verified = await sessionRequest(first.device, first.claims.sessionId)
  assert.equal(decodeReceipt((await verified.json()).session).status, "revoked")
})

test("expired browser-approved pairings retain proof-verified cancellation without delivering access", async (t) => {
  let currentTime = Date.now()
  t.mock.method(Date, "now", () => currentTime)
  const userId = "user_session_expired_cancel"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  const started = await accountStart()
  currentTime = started.expiresAt - 1
  assert.equal((await approval(started, userId)).status, 200)
  const [session] = await listAccountDevices(env.DB, userId)
  assert.ok(session.sessionId)
  currentTime = started.expiresAt
  assert.equal((await accountPoll(started)).status, 410)
  assert.equal((await approval(started, userId, "GET")).status, 410)
  assert.equal((await approval(started, userId)).status, 410)
  assert.equal(
    (
      await pair(started.device, "cancel", started.pairingId, {
        deviceSignature: signedBody(mac(), "cancel", started.pairingId)
          .deviceSignature,
      })
    ).status,
    401
  )
  assert.equal((await listAccountDevices(env.DB, userId)).length, 1)
  const cancelled = await pair(started.device, "cancel", started.pairingId)
  assert.equal(cancelled.status, 200)
  assert.deepEqual(await cancelled.json(), { status: "cancelled" })
  assert.deepEqual(await listAccountDevices(env.DB, userId), [])
  const verified = await sessionRequest(started.device, session.sessionId)
  assert.equal(decodeReceipt((await verified.json()).session).status, "revoked")
})

test("new sign-in cleanup preserves expired cancellation without revoking a replacement session", async (t) => {
  let currentTime = Date.now()
  t.mock.method(Date, "now", () => currentTime)
  const userId = "user_session_expired_cleanup"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  const started = await accountStart()
  const expiredPending = await accountStart()
  currentTime = started.expiresAt - 1
  assert.equal((await approval(started, userId)).status, 200)
  const [session] = await listAccountDevices(env.DB, userId)
  currentTime = expiredPending.expiresAt + 1
  const next = await accountStart({
    ...started.device,
    challenge: randomBytes(32).toString("base64url"),
  })
  const pairing = (pairingId) =>
    env.DB.prepare("SELECT * FROM account_pairings WHERE token_hash = ?")
      .bind(createHash("sha256").update(pairingId).digest("hex"))
      .first()
  assert.equal(
    (await pairing(started.pairingId))?.session_id,
    session.sessionId
  )
  assert.equal(await pairing(expiredPending.pairingId), null)
  assert.equal((await accountPoll(started)).status, 410)
  assert.equal((await approval(started, userId)).status, 410)
  assert.deepEqual(await (await accountPoll(next)).json(), {
    status: "pending",
  })
  assert.equal((await approval(next, userId)).status, 200)
  const claims = decodeReceipt((await (await accountPoll(next)).json()).session)
  assert.notEqual(claims.sessionId, session.sessionId)
  assert.equal(
    (await pair(started.device, "cancel", started.pairingId)).status,
    200
  )
  assert.deepEqual(
    (await listAccountDevices(env.DB, userId)).map(
      (device) => device.sessionId
    ),
    [claims.sessionId]
  )
  await accountStart()
  assert.equal(await pairing(started.pairingId), null)
  assert.equal(
    (await pair(started.device, "cancel", started.pairingId)).status,
    410
  )
  const verified = await sessionRequest(next.device, claims.sessionId)
  assert.equal(decodeReceipt((await verified.json()).session).status, "active")
})

test("cancellation revokes a session approved after its pending pairing snapshot", async () => {
  const userId = "user_cancel_approval_race"
  await assign(userId, "regular", Date.now() + 3_600_000)
  const otherComputer = await accountLogin(userId)
  const started = await accountStart()
  const form = await signInForm(started, userId)
  const snapshotTaken = Promise.withResolvers()
  const continueCancel = Promise.withResolvers()
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql) => {
          const statement = target.prepare(sql)
          if (sql !== "SELECT * FROM account_pairings WHERE token_hash = ?")
            return statement
          return {
            bind(...args) {
              const bound = statement.bind(...args)
              return {
                async first(...firstArgs) {
                  const row = await bound.first(...firstArgs)
                  assert.equal(row.status, "pending")
                  assert.equal(row.session_id, null)
                  snapshotTaken.resolve()
                  await continueCancel.promise
                  return row
                },
              }
            },
          }
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const cancelling = pair(
    started.device,
    "cancel",
    started.pairingId,
    {},
    { ...env, DB: database },
    origin,
    { "Photodepot-Account-Version": "1" }
  )
  let claims
  await snapshotTaken.promise
  try {
    assert.equal(
      (await submitSignIn(started, form.cookie, form.csrf)).status,
      200
    )
    const result = await (await accountPoll(started)).json()
    claims = decodeReceipt(result.session)
    assert.equal(claims.status, "active")
  } finally {
    continueCancel.resolve()
  }
  assert.equal((await cancelling).status, 200)
  const devices = await listAccountDevices(env.DB, userId)
  assert.deepEqual(
    devices.map((device) => device.id),
    [otherComputer.device.deviceId]
  )
  const result = await (
    await sessionRequest(started.device, claims.sessionId)
  ).json()
  assert.equal(decodeReceipt(result.session).status, "revoked")
  assert.equal("receipt" in result, false)
  assert.equal((await accountPoll(started)).status, 410)
  const revision = (await getSubscription(env.DB, userId)).revision
  assert.equal(
    (await pair(started.device, "cancel", started.pairingId)).status,
    410
  )
  assert.equal((await getSubscription(env.DB, userId)).revision, revision)
})

test("session removal wins an in-flight WorkOS outage and never returns cached active authorization", async (t) => {
  const userId = "user_session_remove_race"
  const first = await accountLogin(userId)
  const lookupStarted = Promise.withResolvers()
  const lookupGate = Promise.withResolvers()
  const normalFetch = globalThis.fetch
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith(`/user_management/users/${userId}`)) {
      lookupStarted.resolve()
      await lookupGate.promise
      return Response.json({ message: "Service unavailable" }, { status: 503 })
    }
    return normalFetch(url, options)
  })
  const pending = sessionRequest(first.device, first.claims.sessionId)
  await lookupStarted.promise
  try {
    const removed = await sessionRequest(
      first.device,
      first.claims.sessionId,
      "logout"
    )
    assert.equal(removed.status, 200)
  } finally {
    lookupGate.resolve()
  }
  const response = await pending
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(decodeReceipt(result.session).status, "revoked")
  assert.equal("receipt" in result, false)
})

async function signInForm(
  started,
  userId,
  cookie,
  headers = { "sec-fetch-site": "none" }
) {
  cookie ??= await accountCookie(userId)
  const response = await handleAccountApproval(
    new Request(started.approvalUrl, { headers: { cookie, ...headers } }),
    env
  )
  const html = await response.text()
  return {
    cookie,
    response,
    html,
    csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1],
  }
}
function submitSignIn(
  started,
  cookie,
  csrf,
  replacement,
  bindings = env,
  requestOrigin = origin
) {
  const body = new URLSearchParams({ csrf: csrf ?? "" })
  if (replacement) body.set("replacement", JSON.stringify(replacement))
  return handleAccountApproval(
    new Request(started.approvalUrl, {
      method: "POST",
      headers: {
        cookie,
        origin: requestOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }),
    bindings
  )
}
function selection(loggedIn) {
  return {
    deviceId: loggedIn.device.deviceId,
    sessionId: loggedIn.claims.sessionId,
    revision: loggedIn.claims.revision,
  }
}

test("free slots require explicit computer consent with a protected POST and branded success", async () => {
  const userId = "user_auto_free"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  const started = await accountStart({
    ...mac(),
    deviceName: "Yogesh’s MacBook Pro",
  })
  const form = await signInForm(started, userId)
  assert.equal(form.response.status, 200)
  assert.doesNotMatch(form.html, /requestSubmit|<script/)
  assert.doesNotMatch(
    form.response.headers.get("content-security-policy"),
    /script-src 'nonce-/
  )
  assert.match(form.html, /Sign in on <strong>Yogesh’s MacBook Pro<\/strong>/)
  assert.match(form.html, /Only approve if you just started sign-in/)
  assert.match(form.html, />Approve computer sign-in<\/button>/)
  assert.deepEqual(await listAccountDevices(env.DB, userId), [])
  const response = await submitSignIn(started, form.cookie, form.csrf)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /src="\/brand\/photodepot-lockup.svg"/)
  assert.match(html, /<h1>Signed in<\/h1>/)
  assert.match(html, /Return to Photodepot\./)
  assert.doesNotMatch(html, /Mac/)
  const devices = await listAccountDevices(env.DB, userId)
  assert.equal(devices[0].deviceName, "Yogesh’s MacBook Pro")
  assert.ok(devices[0].lastUsedAt >= devices[0].activatedAt)
})

test("device names are signed, bounded, and refreshed by active session verification", async (t) => {
  const named = { ...mac(), deviceName: "Studio Computer" }
  assert.equal(
    (
      await pair(
        named,
        "start",
        undefined,
        { deviceName: "Altered name" },
        env,
        origin,
        { "Photodepot-Account-Version": "1" }
      )
    ).status,
    401
  )
  for (const name of [
    "",
    " leading",
    "trailing ",
    "bad\nname",
    "x".repeat(121),
  ])
    assert.equal(
      (
        await pair(
          mac(),
          "start",
          undefined,
          { deviceName: name },
          env,
          origin,
          { "Photodepot-Account-Version": "1" }
        )
      ).status,
      400
    )
  const loggedIn = await accountLogin("user_device_metadata", named)
  let current = Date.now()
  t.mock.method(Date, "now", () => current)
  const before = (await listAccountDevices(env.DB, loggedIn.claims.userId))[0]
  current += 1000
  const response = await sessionRequest(
    loggedIn.device,
    loggedIn.claims.sessionId,
    "verify",
    { deviceName: "Renamed Studio Computer" }
  )
  assert.equal(response.status, 200)
  const after = (await listAccountDevices(env.DB, loggedIn.claims.userId))[0]
  assert.equal(after.deviceName, "Renamed Studio Computer")
  assert.ok(after.lastUsedAt > before.lastUsedAt)
  assert.equal(after.revision, before.revision)
  const bad = await sessionRequest(
    loggedIn.device,
    loggedIn.claims.sessionId,
    "verify",
    { deviceName: "" }
  )
  assert.equal(bad.status, 400)
})

test("full slots show real computer names and replace only the selected current session atomically", async () => {
  const userId = "user_auto_replace"
  const first = await accountLogin(userId, {
    ...mac(),
    deviceName: "Office <Computer>",
  })
  const second = await accountLogin(userId, {
    ...mac(),
    deviceName: "Travel Computer",
  })
  const incoming = await accountStart({ ...mac(), deviceName: "New Computer" })
  const form = await signInForm(incoming, userId)
  assert.match(form.html, /Office &lt;Computer&gt;/)
  assert.match(form.html, /Travel Computer/)
  assert.match(form.html, /Last used/)
  assert.match(form.html, /Remove and sign in/)
  assert.doesNotMatch(form.html, /requestSubmit|<script/)
  assert.match(form.html, /Sign in on <strong>New Computer<\/strong>/)
  assert.equal(
    (
      await submitSignIn(incoming, form.cookie, form.csrf, {
        ...selection(first),
        revision: 9,
      })
    ).status,
    409
  )
  assert.equal((await listAccountDevices(env.DB, userId)).length, 2)
  assert.equal(
    (await submitSignIn(incoming, form.cookie, form.csrf, selection(first)))
      .status,
    200
  )
  const devices = await listAccountDevices(env.DB, userId)
  assert.deepEqual(
    new Set(devices.map((value) => value.id)),
    new Set([second.device.deviceId, incoming.device.deviceId])
  )
  assert.equal(
    decodeReceipt(
      (
        await (
          await sessionRequest(first.device, first.claims.sessionId)
        ).json()
      ).session
    ).status,
    "revoked"
  )
  assert.equal((await accountPoll(incoming)).status, 200)
  // A replay after success cannot select and remove another computer.
  assert.equal(
    (await submitSignIn(incoming, form.cookie, form.csrf, selection(second)))
      .status,
    200
  )
  assert.deepEqual(await listAccountDevices(env.DB, userId), devices)
})

test("computer consent CSRF is bound to the account, browser session, pairing, expiry and origin", async (t) => {
  const userId = "user_auto_csrf"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  users.set("user_auto_csrf_other", {
    email: "other@example.com",
    emailVerified: true,
  })
  const started = await accountStart()
  const other = await accountStart()
  const form = await signInForm(started, userId)
  for (const [target, cookie, csrf, requestOrigin] of [
    [started, form.cookie, "", origin],
    [started, form.cookie, form.csrf, "https://attacker.example"],
    [
      started,
      await accountCookie(userId, "account", "other_browser_session"),
      form.csrf,
      origin,
    ],
    [started, await accountCookie("user_auto_csrf_other"), form.csrf, origin],
    [other, form.cookie, form.csrf, origin],
  ])
    assert.equal(
      (await submitSignIn(target, cookie, csrf, undefined, env, requestOrigin))
        .status,
      403
    )
  t.mock.method(Date, "now", () => Number(form.csrf.split(".")[0]) + 1)
  assert.equal(
    (await submitSignIn(started, form.cookie, form.csrf)).status,
    403
  )
  assert.deepEqual(await listAccountDevices(env.DB, userId), [])
})

test("cancelled and foreign replacement selections cannot sign out any existing computer", async () => {
  const userId = "user_auto_cancel"
  const first = await accountLogin(userId)
  await accountLogin(userId)
  const foreign = await accountLogin("user_auto_foreign")
  const incoming = await accountStart()
  const form = await signInForm(incoming, userId)
  assert.equal(
    (await submitSignIn(incoming, form.cookie, form.csrf, selection(foreign)))
      .status,
    409
  )
  await pair(incoming.device, "cancel", incoming.pairingId)
  assert.equal(
    (await submitSignIn(incoming, form.cookie, form.csrf, selection(first)))
      .status,
    410
  )
  assert.equal((await listAccountDevices(env.DB, userId)).length, 2)
  assert.equal(
    (await listAccountDevices(env.DB, foreign.claims.userId)).length,
    1
  )
})

test("concurrent replacement forms have one winner and preserve two active computers", async () => {
  const userId = "user_auto_replace_race"
  const first = await accountLogin(userId)
  const second = await accountLogin(userId)
  const incoming = await Promise.all([accountStart(), accountStart()])
  const forms = await Promise.all(
    incoming.map((value) => signInForm(value, userId))
  )
  const responses = await Promise.all(
    incoming.map((value, index) =>
      submitSignIn(
        value,
        forms[index].cookie,
        forms[index].csrf,
        selection(first)
      )
    )
  )
  assert.deepEqual(responses.map((value) => value.status).sort(), [200, 409])
  const devices = await listAccountDevices(env.DB, userId)
  assert.equal(devices.length, 2)
  assert.ok(devices.some((value) => value.id === second.device.deviceId))
  assert.ok(!devices.some((value) => value.id === first.device.deviceId))
})

test("external application links, direct navigation, and redirects require explicit computer consent", async () => {
  const userId = "user_foreign_link"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  const started = await accountStart({
    ...mac(),
    deviceName: "Candidate <Computer>",
  })
  for (const headers of [
    {},
    { "sec-fetch-site": "none" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "same-origin" },
  ]) {
    const form = await signInForm(started, userId, undefined, headers)
    assert.doesNotMatch(form.html, /requestSubmit|<script/)
    assert.match(
      form.html,
      /Sign in on <strong>Candidate &lt;Computer&gt;<\/strong>/
    )
    assert.match(form.html, />Approve computer sign-in<\/button>/)
    assert.match(form.html, /Only approve if you just started sign-in/)
    assert.deepEqual(await (await accountPoll(started)).json(), {
      status: "pending",
    })
  }
  assert.deepEqual(await listAccountDevices(env.DB, userId), [])
})

test("hosted authentication preserves login and signup intent but still requires computer consent", async () => {
  const userId = "user_native_hosted_return"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  for (const intent of ["login", "signup"]) {
    const device = mac()
    const response = await pair(device, "start", undefined, {}, env, origin, {
      "Photodepot-Account-Version": "1",
      "Photodepot-Account-Intent": intent,
    })
    assert.equal(response.status, 201)
    const started = { ...(await response.json()), device, account: true }
    const anonymousNative = await handleAccountApproval(
      new Request(started.approvalUrl, {
        headers: { "sec-fetch-site": "none" },
      }),
      env
    )
    assert.equal(anonymousNative.status, 302)
    assert.equal(
      anonymousNative.headers.get("location"),
      `/api/account/auth/login?code=${new URL(started.approvalUrl).searchParams.get("code")}${intent === "signup" ? "&intent=signup" : ""}`
    )
    assert.ok(
      !anonymousNative.headers
        .getSetCookie()
        .some((value) => value.includes("photodepot-device-intent"))
    )
    // Even a still-valid cookie minted before this fix cannot skip consent.
    const nativeCookie = `__Host-photodepot-device-intent=${await sealData(
      {
        version: 1,
        origin,
        pairing: createHash("sha256").update(started.pairingId).digest("hex"),
        nonce: randomBytes(32).toString("base64url"),
        expiresAt: started.expiresAt,
      },
      { password: cookiePassword, ttl: 600 }
    )}`
    const cookie = `${await accountCookie(userId)}; ${nativeCookie}`
    const callback = await signInForm(started, userId, cookie, {
      "sec-fetch-site": "cross-site",
    })
    assert.doesNotMatch(callback.html, /requestSubmit|<script/)
    assert.match(callback.html, />Approve computer sign-in<\/button>/)
    const foreign = await accountStart()
    const wrongPairing = await signInForm(foreign, userId, cookie, {
      "sec-fetch-site": "same-origin",
    })
    assert.doesNotMatch(wrongPairing.html, /requestSubmit/)
    const duplicate = await signInForm(
      started,
      userId,
      `${cookie}; ${nativeCookie}`,
      { "sec-fetch-site": "cross-site" }
    )
    assert.doesNotMatch(duplicate.html, /requestSubmit/)
    assert.deepEqual(await (await accountPoll(started)).json(), {
      status: "pending",
    })
    assert.equal(
      (await submitSignIn(started, callback.cookie, callback.csrf)).status,
      200
    )
    assert.equal((await accountPoll(started)).status, 200)
  }
})

test("legacy keys and pairing v0 return update-required without issuing or refreshing authority", async () => {
  for (const action of ["activate", "verify"]) {
    const response = await handleLicenseRequest(
      new Request(`${origin}/api/licenses/${action}`, { method: "POST" }),
      env,
      action
    )
    assert.equal(response.status, 410)
    assert.equal((await response.json()).code, "update_required")
  }
  const response = await pair(mac(), "start", undefined, {}, env, origin, {
    "Photodepot-Account-Version": "0",
  })
  assert.equal(response.status, 410)
  assert.equal((await response.json()).code, "update_required")
})
test("modern pairing rejects forged signatures and replay into another proof, device or action", async () => {
  const first = mac(),
    second = mac()
  const started = await accountStart(first)
  for (const changes of [
    { deviceSignature: "a".repeat(86) },
    { challenge: randomBytes(32).toString("base64url") },
    { deviceId: second.deviceId },
  ])
    assert.equal(
      (await pair(first, "poll", started.pairingId, changes)).status,
      401
    )
  const forged = await pair(second, "start", undefined, {
    deviceSignature: "a".repeat(86),
  })
  assert.equal(forged.status, 401)
  assert.equal((await accountPoll(started)).status, 200)
  assert.equal((await (await accountPoll(started)).json()).status, "pending")
  const forgedCancel = signedBody(first, "poll", started.pairingId)
  assert.equal(
    (
      await pair(first, "cancel", started.pairingId, {
        deviceSignature: forgedCancel.deviceSignature,
      })
    ).status,
    401
  )
})

test("modern browser approval and receipt delivery recheck live verified account status", async () => {
  const userId = "user_pairing_fresh_status"
  users.set(userId, { email: "fresh@example.test", emailVerified: false })
  const started = await accountStart()
  assert.equal((await approval(started, userId)).status, 403)
  users.set(userId, { email: "fresh@example.test", emailVerified: true })
  assert.equal((await approval(started, userId)).status, 200)
  users.delete(userId)
  assert.equal((await accountPoll(started)).status, 403)
  users.set(userId, "unavailable")
  assert.equal((await accountPoll(started)).status, 503)
})
test("modern pairing start enforces its IP rate limit before another approval can be created", async () => {
  const device = mac()
  async function attempt() {
    return handleAccountPairing(
      new Request(`${origin}/api/account/pairing/start`, {
        method: "POST",
        headers: {
          "Photodepot-Account-Version": "1",
          "content-type": "application/json",
          "cf-connecting-ip": "rate-limit-modern-start",
        },
        body: JSON.stringify(signedBody(device, "start")),
      }),
      env,
      "start"
    )
  }
  for (let index = 0; index < 12; index++)
    assert.equal((await attempt()).status, 201)
  const blocked = await attempt()
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get("retry-after"), "600")
})
