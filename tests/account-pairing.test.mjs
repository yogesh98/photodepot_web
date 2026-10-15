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
import {
  getSubscription,
  listSubscriptionAudit,
  setSubscription,
  SubscriptionConflictError,
} from "../lib/subscription-store.ts"
import {
  getSubscriptionDevice,
  bindSubscriptionDevice,
  resetSubscriptionDevice,
} from "../lib/subscription-devices.ts"
import {
  handleDesktopSession,
  listAccountDevices,
} from "../lib/account-sessions.ts"
import { handleAccountSubscription } from "../functions/api/account/subscription.ts"
import { handleLicenseRequest } from "../lib/license-api.ts"

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
        "cf-connecting-ip": `pairing-test-${sequence++}`,
        ...headers,
      },
      body: JSON.stringify(signedBody(device, action, pairingId, changes)),
    }),
    bindings,
    action
  )
}

async function start(device = mac()) {
  const response = await pair(device)
  assert.equal(response.status, 201)
  const started = await response.json()
  assert.match(started.pairingId, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(started.expiresInMs, 600_000)
  const url = new URL(started.approvalUrl)
  assert.equal(url.origin, origin)
  assert.equal(url.pathname, "/account/activate")
  assert.match(url.searchParams.get("code"), /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(url.searchParams.get("code"), started.pairingId)
  return { ...started, device }
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

test("pairing receipts preserve legacy payloads and expose subscription expiry to negotiated clients", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_pairing_receipt_versions"
  const subscription = await assign(userId, "regular", epoch + 30 * 60_000)
  const started = await start()
  assert.equal((await approval(started, userId)).status, 200)
  for (const version of [undefined, "1", "2", "3"]) {
    const response = await pair(
      started.device,
      "poll",
      started.pairingId,
      {},
      env,
      origin,
      version ? { "Photodepot-Receipt-Version": version } : {}
    )
    assert.equal(response.status, 200)
    const receipt = (await response.json()).receipt
    const payload = decodeReceipt(receipt)
    assert.equal(payload.expiresAt, subscription.endsAt)
    assert.equal(
      payload.subscriptionEndsAt,
      ["2", "3"].includes(version) ? subscription.endsAt : undefined
    )
    assert.deepEqual(
      Object.keys(payload).sort(),
      [
        "version",
        "licenseId",
        "deviceId",
        "type",
        "status",
        "challenge",
        "revision",
        "issuedAt",
        "expiresAt",
        ...(["2", "3"].includes(version) ? ["subscriptionEndsAt"] : []),
      ].sort()
    )
    assert.deepEqual(
      Object.keys(receipt).sort(),
      [
        "payload",
        "signature",
        ...(["2", "3"].includes(version) ? ["collaborationReceipt"] : []),
      ].sort()
    )
    if (["2", "3"].includes(version)) {
      const compatible = decodeReceipt(receipt.collaborationReceipt)
      const expected = { ...payload }
      delete expected.subscriptionEndsAt
      assert.deepEqual(compatible, expected)
      assert.deepEqual(Object.keys(receipt.collaborationReceipt).sort(), [
        "payload",
        "signature",
      ])
    }
  }
})

test("desktop pairing completes through browser consent and retries the same proof without exposing credentials", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_pairing_complete"
  const subscription = await assign(userId, "regular")
  const started = await start()
  const pending = await pair(started.device, "poll", started.pairingId)
  assert.deepEqual(await pending.json(), { status: "pending" })
  const anonymous = await approval(started, undefined, "GET")
  assert.equal(anonymous.status, 302)
  assert.equal(
    new URL(anonymous.headers.get("location"), origin).pathname,
    "/api/account/auth/login"
  )
  const row = await env.DB.prepare(
    "SELECT * FROM account_pairings WHERE device_id = ?"
  )
    .bind(started.device.deviceId)
    .first()
  assert.notEqual(row.token_hash, started.pairingId)
  assert.equal(
    row.token_hash,
    createHash("sha256").update(started.pairingId).digest("hex")
  )
  assert.equal(
    row.code_hash,
    createHash("sha256")
      .update(new URL(started.approvalUrl).searchParams.get("code"))
      .digest("hex")
  )
  const preview = await approval(started, userId, "GET")
  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get("cache-control"), "private, no-store")
  assert.equal(preview.headers.get("referrer-policy"), "same-origin")
  assert.match(
    preview.headers.get("content-security-policy"),
    /frame-ancestors 'none'/
  )
  const html = await preview.text()
  assert.match(html, /Approve Mac sign-in/)
  assert.match(html, /<form method="post" action="\/account\/activate\?code=/)
  assert.match(
    html,
    /<form method="post" action="\/api\/account\/auth\/logout">/
  )
  for (const secret of [
    started.pairingId,
    jwt(userId),
    `refresh_${userId}`,
    env.WORKOS_API_KEY,
    env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY,
  ])
    assert.equal(html.includes(secret), false)
  assert.equal((await approval(started, userId)).status, 200)
  const approved = await pair(started.device, "poll", started.pairingId)
  assert.equal(approved.status, 200)
  const result = await approved.json()
  assert.equal(result.status, "approved")
  const receipt = decodeReceipt(result.receipt)
  assert.equal(receipt.licenseId, subscription.id)
  assert.equal(receipt.status, "active")
  assert.equal(receipt.type, "regular")
  assert.equal(receipt.challenge, started.device.challenge)
  assert.equal(receipt.deviceId, started.device.deviceId)
  assert.equal(receipt.expiresAt, subscription.endsAt)
  assert.equal(receipt.revision, 2)
  for (const field of ["email", "userId", "refreshToken", "accessToken"])
    assert.equal(field in receipt, false)
  const retry = await pair(started.device, "poll", started.pairingId)
  assert.deepEqual(await retry.json(), result)
  assert.equal((await listSubscriptionAudit(env.DB, userId)).length, 2)
})

test("pairing validates exact start/poll/cancel proof fields and never transfers an approved request", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const device = mac()
  assert.equal(
    (
      await pair(device, "start", undefined, {
        deviceSignature: signedBody(mac(), "start").deviceSignature,
      })
    ).status,
    401
  )
  assert.equal(
    (await pair(device, "start", undefined, { deviceId: mac().deviceId }))
      .status,
    401
  )
  assert.equal(
    (await pair(device, "start", undefined, { devicePublicKey: "bad" })).status,
    400
  )
  const started = await start(device)
  for (const action of ["poll", "cancel"]) {
    assert.equal(
      (
        await pair(device, action, started.pairingId, {
          deviceId: mac().deviceId,
        })
      ).status,
      401
    )
    assert.equal(
      (
        await pair(device, action, started.pairingId, {
          challenge: mac().challenge,
        })
      ).status,
      401
    )
    assert.equal(
      (
        await pair(device, action, started.pairingId, {
          deviceSignature: signedBody(mac(), action, started.pairingId)
            .deviceSignature,
        })
      ).status,
      401
    )
  }
  assert.equal((await pair(device, "poll", "invalid")).status, 400)
  assert.deepEqual(
    await (await pair(device, "poll", started.pairingId)).json(),
    { status: "pending" }
  )
})

test("cancelled, replaced and expired sign-in requests cannot be approved or poll authorization", async (t) => {
  let currentTime = epoch
  t.mock.method(Date, "now", () => currentTime)
  const userId = "user_pairing_lifecycle"
  await assign(userId)
  const cancelled = await start()
  assert.deepEqual(
    await (await pair(cancelled.device, "cancel", cancelled.pairingId)).json(),
    { status: "cancelled" }
  )
  assert.equal(
    (await pair(cancelled.device, "poll", cancelled.pairingId)).status,
    410
  )
  assert.equal((await approval(cancelled, userId)).status, 410)
  const expired = await start()
  currentTime = expired.expiresAt
  assert.equal(
    (await pair(expired.device, "poll", expired.pairingId)).status,
    410
  )
  assert.equal((await approval(expired, userId)).status, 410)
  currentTime = epoch
  const device = mac()
  const replaced = await start(device)
  await start(device)
  assert.equal((await pair(device, "poll", replaced.pairingId)).status, 410)
  assert.equal(
    await getSubscriptionDevice(env.DB, device.deviceId, epoch),
    null
  )
})

test("cancelling an approved poll during WorkOS lookup cannot claim Mac access", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_pairing_cancel_during_lookup"
  const subscription = await assign(userId)
  const started = await start()
  assert.equal((await approval(started, userId)).status, 200)
  const lookupStarted = Promise.withResolvers()
  const lookupGate = Promise.withResolvers()
  const normalFetch = globalThis.fetch
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith(`/user_management/users/${userId}`)) {
      lookupStarted.resolve()
      await lookupGate.promise
    }
    return normalFetch(url, options)
  })
  const pendingPoll = pair(started.device, "poll", started.pairingId)
  try {
    await lookupStarted.promise
    const cancelled = await pair(started.device, "cancel", started.pairingId)
    assert.deepEqual(await cancelled.json(), { status: "cancelled" })
  } finally {
    lookupGate.resolve()
  }
  const response = await pendingPoll
  assert.equal(response.status, 409)
  assert.equal("receipt" in (await response.json()), false)
  assert.equal(
    await getSubscriptionDevice(env.DB, started.device.deviceId, epoch),
    null
  )
  assert.deepEqual(await getSubscription(env.DB, userId, epoch), subscription)
  assert.equal((await listSubscriptionAudit(env.DB, userId)).length, 1)
})

test("cancellation and live expiry at the binding transaction boundary prevent authorization", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  for (const reason of ["cancel", "pairing-expiry", "subscription-expiry"]) {
    const userId = `user_pairing_before_transaction_${reason.replaceAll("-", "_")}`
    await assign(userId)
    const started = await start()
    assert.equal((await approval(started, userId)).status, 200)
    const bindingStarted = Promise.withResolvers()
    const bindingGate = Promise.withResolvers()
    let batchCount = 0
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements) => {
            // The poll's first batch updates its rate limit. Pause the subsequent
            // binding batch after all application-level authorization reads.
            if (++batchCount === 2) {
              bindingStarted.resolve()
              await bindingGate.promise
            }
            return target.batch(statements)
          }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const pendingPoll = pair(
      started.device,
      "poll",
      started.pairingId,
      {},
      { ...env, DB: database }
    )
    try {
      await bindingStarted.promise
      if (reason === "cancel") {
        assert.equal(
          (await pair(started.device, "cancel", started.pairingId)).status,
          200
        )
      } else {
        const { now: databaseNow } = await env.DB.prepare(
          "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now"
        ).first()
        assert.ok(Number.isSafeInteger(databaseNow))
        const expiredAt = databaseNow - 1
        // This is still later than the poll's captured application timestamp.
        // Only an execution-time database clock can observe the expiration.
        assert.ok(expiredAt > epoch)
        if (reason === "pairing-expiry")
          await env.DB.prepare(
            "UPDATE account_pairings SET expires_at = ? WHERE token_hash = ?"
          )
            .bind(
              expiredAt,
              createHash("sha256").update(started.pairingId).digest("hex")
            )
            .run()
        else
          await env.DB.prepare(
            "UPDATE subscriptions SET end_at = ? WHERE user_id = ?"
          )
            .bind(expiredAt, userId)
            .run()
      }
    } finally {
      bindingGate.resolve()
    }
    const response = await pendingPoll
    assert.equal(response.status, 409)
    assert.equal("receipt" in (await response.json()), false)
    assert.equal(
      await getSubscriptionDevice(env.DB, started.device.deviceId, epoch),
      null
    )
    assert.deepEqual(
      await env.DB.prepare(
        "SELECT revision FROM subscriptions WHERE user_id = ?"
      )
        .bind(userId)
        .first(),
      { revision: 1 }
    )
    assert.equal((await listSubscriptionAudit(env.DB, userId)).length, 1)
  }
})

test("pairing and subscription expiry during WorkOS lookup prevent authorization", async (t) => {
  let currentTime = epoch
  t.mock.method(Date, "now", () => currentTime)
  const normalFetch = globalThis.fetch
  for (const reason of ["pairing", "subscription"]) {
    currentTime = epoch
    const userId = `user_pairing_expiry_during_lookup_${reason}`
    const subscription = await assign(
      userId,
      "regular",
      epoch + (reason === "subscription" ? 1000 : 3600_000)
    )
    const started = await start()
    assert.equal((await approval(started, userId)).status, 200)
    const lookupStarted = Promise.withResolvers()
    const lookupGate = Promise.withResolvers()
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith(`/user_management/users/${userId}`)) {
        lookupStarted.resolve()
        await lookupGate.promise
      }
      return normalFetch(url, options)
    }
    const pendingPoll = pair(started.device, "poll", started.pairingId)
    try {
      await lookupStarted.promise
      currentTime =
        reason === "pairing" ? started.expiresAt : subscription.endsAt
    } finally {
      lookupGate.resolve()
      globalThis.fetch = normalFetch
    }
    const response = await pendingPoll
    assert.equal(response.status, reason === "pairing" ? 410 : 403)
    assert.equal("receipt" in (await response.json()), false)
    assert.equal(
      await getSubscriptionDevice(env.DB, started.device.deviceId, epoch),
      null
    )
    assert.deepEqual(await getSubscription(env.DB, userId, epoch), subscription)
    assert.equal((await listSubscriptionAudit(env.DB, userId)).length, 1)
  }
})

test("browser approval requires an existing subscription and does not grant access by itself", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_pairing_ungranted"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  const started = await start()
  const denied = await approval(started, userId)
  assert.equal(denied.status, 403)
  const deniedPage = await denied.text()
  assert.match(deniedPage, /does not have a subscription yet/)
  assert.match(deniedPage, /href="\/account"/)
  assert.match(
    deniedPage,
    /form method="post" action="\/api\/account\/auth\/logout"/
  )
  assert.match(deniedPage, /Using the wrong account/)
  assert.equal(await getSubscription(env.DB, userId, epoch), null)
  assert.equal(
    await getSubscriptionDevice(env.DB, started.device.deviceId, epoch),
    null
  )
  assert.deepEqual(
    await (await pair(started.device, "poll", started.pairingId)).json(),
    { status: "pending" }
  )
  await setSubscription(
    env.DB,
    { userId, type: "trial", endsAt: epoch + 3600_000, expectedRevision: 0 },
    "owner@example.com",
    epoch
  )
  assert.equal((await approval(started, userId)).status, 200)
  assert.equal(
    (await pair(started.device, "poll", started.pairingId)).status,
    200
  )
})

test("browser approval requires a verified customer session, canonical host and same-origin consent", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_pairing_origin"
  await assign(userId)
  const started = await start()
  for (const requestOrigin of ["https://attacker.example", "null", ""]) {
    assert.equal(
      (
        await approval(started, userId, "POST", {
          origin: requestOrigin,
          referer: started.approvalUrl,
        })
      ).status,
      403
    )
  }
  assert.equal(
    (
      await handleAccountApproval(
        new Request(started.approvalUrl, {
          method: "POST",
          headers: {
            cookie: await accountCookie(userId),
            referer: started.approvalUrl,
          },
        }),
        env
      )
    ).status,
    403
  )
  assert.equal(
    (
      await approval(
        started,
        userId,
        "GET",
        {},
        "https://preview.photodepot-web.pages.dev"
      )
    ).status,
    403
  )
  assert.equal(
    (
      await pair(
        started.device,
        "poll",
        started.pairingId,
        {},
        env,
        "https://preview.photodepot-web.pages.dev"
      )
    ).status,
    403
  )
  const adminAudience = await approval(started, userId, "GET", {
    cookie: await accountCookie(userId, "admin"),
  })
  assert.equal(adminAudience.status, 302)
  const anonymousPost = await approval(started, undefined)
  assert.equal(anonymousPost.status, 401)
  assert.deepEqual(
    await (await pair(started.device, "poll", started.pairingId)).json(),
    { status: "pending" }
  )
  assert.equal(
    (
      await pair(
        started.device,
        "start",
        undefined,
        {},
        { ...env, WORKOS_API_KEY: "" }
      )
    ).status,
    503
  )
  for (const missing of [
    "WORKOS_CLIENT_ID",
    "WORKOS_COOKIE_PASSWORD",
    "WORKOS_REDIRECT_URI",
  ]) {
    assert.equal(
      (
        await pair(
          started.device,
          "start",
          undefined,
          {},
          {
            ...env,
            [missing]: "",
          }
        )
      ).status,
      503
    )
  }
  assert.equal(
    (
      await pair(
        started.device,
        "start",
        undefined,
        {},
        { ...env, WORKOS_ADMIN_ORGANIZATION_ID: "" }
      )
    ).status,
    201
  )
})

test("two accounts approving one request have exactly one immutable winner", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userIds = ["user_pairing_first", "user_pairing_second"]
  const subscriptions = await Promise.all(
    userIds.map((id, index) => assign(id, index ? "regular" : "trial"))
  )
  const started = await start()
  const results = await Promise.all(
    userIds.map((userId) => approval(started, userId))
  )
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409])
  const winner = results.findIndex(({ status }) => status === 200)
  const loser = 1 - winner
  const row = await env.DB.prepare(
    "SELECT user_id FROM account_pairings WHERE token_hash = ?"
  )
    .bind(createHash("sha256").update(started.pairingId).digest("hex"))
    .first()
  assert.equal(row.user_id, userIds[winner])
  assert.equal((await approval(started, userIds[loser])).status, 409)
  const receipt = decodeReceipt(
    (await (await pair(started.device, "poll", started.pairingId)).json())
      .receipt
  )
  assert.equal(receipt.licenseId, subscriptions[winner].id)
  assert.equal(
    await getSubscriptionDevice(env.DB, started.device.deviceId, epoch).then(
      ({ userId }) => userId
    ),
    userIds[winner]
  )
})

test("two Macs connect, a third is refused, and old approvals cannot reclaim slots after Owner reset", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_pairing_reset"
  await assign(userId)
  const first = await start()
  const second = await start()
  const third = await start()
  // Approve before either delivery, so the database commit must enforce capacity.
  for (const request of [first, second, third])
    assert.equal((await approval(request, userId)).status, 200)
  assert.equal((await pair(first.device, "poll", first.pairingId)).status, 200)
  assert.equal(
    (await pair(second.device, "poll", second.pairingId)).status,
    200
  )
  assert.equal((await pair(third.device, "poll", third.pairingId)).status, 409)
  assert.equal((await getSubscription(env.DB, userId, epoch)).devices.length, 2)
  const fourth = await start()
  assert.equal((await approval(fourth, userId)).status, 409)
  const reset = await resetSubscriptionDevice(
    env.DB,
    userId,
    3,
    "owner@example.com",
    epoch
  )
  const auditCount = (await listSubscriptionAudit(env.DB, userId)).length
  for (const request of [first, second, third])
    assert.equal(
      (await pair(request.device, "poll", request.pairingId)).status,
      409
    )
  assert.equal(
    (await getSubscriptionDevice(env.DB, first.device.deviceId, epoch)).active,
    false
  )
  assert.equal(
    (await getSubscriptionDevice(env.DB, second.device.deviceId, epoch)).active,
    false
  )
  assert.deepEqual(await getSubscription(env.DB, userId, epoch), reset)
  assert.equal((await listSubscriptionAudit(env.DB, userId)).length, auditCount)
  const fresh = await start(second.device)
  assert.equal((await approval(fresh, userId)).status, 200)
  assert.equal((await pair(fresh.device, "poll", fresh.pairingId)).status, 200)
})

test("fresh WorkOS account status is enforced during approval and every delivery", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  for (const state of ["deleted", "unverified", "unavailable"]) {
    const userId = `user_pairing_${state}`
    await assign(userId)
    const started = await start()
    assert.equal((await approval(started, userId)).status, 200)
    if (state === "deleted") users.delete(userId)
    else if (state === "unverified")
      users.set(userId, {
        email: `${userId}@example.com`,
        emailVerified: false,
      })
    else users.set(userId, "unavailable")
    const expected = state === "unavailable" ? 503 : 403
    assert.equal(
      (await pair(started.device, "poll", started.pairingId)).status,
      expected
    )
    assert.equal((await approval(started, userId, "GET")).status, expected)
    assert.equal(
      await getSubscriptionDevice(env.DB, started.device.deviceId, epoch),
      null
    )
  }
})

test("parallel signed approvals deliver exactly two active receipts and never assign a third Mac", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_signed_two_slot_race"
  await assign(userId)
  const pairings = await Promise.all(Array.from({ length: 6 }, () => start()))
  for (const request of pairings)
    assert.equal((await approval(request, userId)).status, 200)
  const deliveries = await Promise.all(
    pairings.map((request) => pair(request.device, "poll", request.pairingId))
  )
  assert.equal(deliveries.filter(({ status }) => status === 200).length, 2)
  assert.equal(deliveries.filter(({ status }) => status === 409).length, 4)
  const assigned = await getSubscription(env.DB, userId, epoch)
  assert.equal(assigned.devices.length, 2)
  assert.equal(assigned.revision, 3)
  for (const [index, response] of deliveries.entries()) {
    const result = await response.json()
    if (response.status === 200) {
      const receipt = decodeReceipt(result.receipt)
      assert.equal(receipt.status, "active")
      assert.equal(receipt.deviceId, pairings[index].device.deviceId)
      assert.equal(receipt.licenseId, assigned.id)
      assert.equal(
        assigned.devices.some((device) => device.id === receipt.deviceId),
        true
      )
    } else assert.equal("receipt" in result, false)
  }
  assert.equal((await listSubscriptionAudit(env.DB, userId)).length, 3)
})

test("individual reset invalidates that Mac's old approval while the other Mac can retry and fresh browser consent reconnects", async (t) => {
  t.mock.method(Date, "now", () => epoch)
  const userId = "user_pairing_individual_reset"
  await assign(userId)
  const first = await start(),
    second = await start()
  for (const request of [first, second]) {
    assert.equal((await approval(request, userId)).status, 200)
    assert.equal(
      (await pair(request.device, "poll", request.pairingId)).status,
      200
    )
  }
  const reset = await resetSubscriptionDevice(
    env.DB,
    userId,
    3,
    "owner@example.com",
    epoch,
    "Reset only this Mac",
    first.device.deviceId
  )
  assert.equal(reset.bindingRevision, 1)
  assert.deepEqual(
    reset.devices.map(({ id }) => id),
    [second.device.deviceId]
  )
  assert.equal((await pair(first.device, "poll", first.pairingId)).status, 409)
  assert.equal(
    (await pair(second.device, "poll", second.pairingId)).status,
    200
  )
  const renewed = await start(first.device)
  assert.equal((await approval(renewed, userId)).status, 200)
  const delivered = await pair(renewed.device, "poll", renewed.pairingId)
  assert.equal(delivered.status, 200)
  const payload = decodeReceipt((await delivered.json()).receipt)
  assert.equal(payload.deviceId, first.device.deviceId)
  const current = await getSubscription(env.DB, userId, epoch)
  assert.equal(current.devices.length, 2)
  assert.equal(
    current.devices.find(({ id }) => id === first.device.deviceId)
      .assignmentRevision,
    2
  )
  assert.equal(
    current.devices.find(({ id }) => id === second.device.deviceId)
      .assignmentRevision,
    1
  )
  assert.equal((await pair(first.device, "poll", first.pairingId)).status, 409)
  assert.equal(
    (await pair(second.device, "poll", second.pairingId)).status,
    200
  )
  assert.equal((await listSubscriptionAudit(env.DB, userId)).length, 5)
})

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

test("subscription expiry and revocation remove local entitlement while keeping the account session active", async () => {
  const userId = "user_session_entitlement"
  await assign(userId, "regular", Date.now() + 3600_000)
  const loggedIn = await accountLogin(userId)
  assert.equal(decodeReceipt(loggedIn.result.receipt).status, "active")
  assert.equal(
    decodeReceipt(loggedIn.result.receipt).challenge,
    loggedIn.claims.challenge
  )
  await env.DB.prepare("UPDATE subscriptions SET end_at = ? WHERE user_id = ?")
    .bind(Date.now() - 1, userId)
    .run()
  for (const state of ["expired", "revoked"]) {
    if (state === "revoked")
      await env.DB.prepare(
        "UPDATE subscriptions SET status = 'revoked' WHERE user_id = ?"
      )
        .bind(userId)
        .run()
    const response = await sessionRequest(
      loggedIn.device,
      loggedIn.claims.sessionId
    )
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(decodeReceipt(result.session).status, "active")
    assert.equal("receipt" in result, false)
  }
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
  assert.equal(account.subscription, null)
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
    400
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

test("free account approvals enforce two Macs atomically and Owner resets revoke subscribed sessions", async () => {
  const userId = "user_session_capacity"
  users.set(userId, { email: `${userId}@example.com`, emailVerified: true })
  const started = await Promise.all(
    Array.from({ length: 4 }, () => accountStart())
  )
  const approvals = await Promise.all(
    started.map((value) => approval(value, userId))
  )
  assert.equal(approvals.filter((value) => value.status === 200).length, 2)
  assert.equal(approvals.filter((value) => value.status === 409).length, 2)
  assert.equal((await listAccountDevices(env.DB, userId)).length, 2)
  const subscription = await assign(userId, "regular", Date.now() + 3600_000)
  assert.equal(subscription.devices.length, 2)
  const connected =
    started[approvals.findIndex((value) => value.status === 200)]
  const before = decodeReceipt(
    (await (await accountPoll(connected)).json()).session
  )
  const reset = await resetSubscriptionDevice(
    env.DB,
    userId,
    subscription.revision,
    "owner@example.com",
    Date.now(),
    "Test reset",
    connected.device.deviceId
  )
  assert.equal(reset.devices.length, 1)
  const verified = await sessionRequest(connected.device, before.sessionId)
  assert.equal(decodeReceipt((await verified.json()).session).status, "revoked")
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

test("fresh session approval invalidates stale administrative Mac removal and logout advances the subscription revision only once", async () => {
  const userId = "user_session_admin_revision"
  await assign(userId, "regular", Date.now() + 3600_000)
  const first = await accountLogin(userId)
  const original = await getSubscription(env.DB, userId)
  const second = await accountLogin(userId, first.device)
  const current = await getSubscription(env.DB, userId)
  assert.equal(current.revision, original.revision + 1)
  await assert.rejects(
    resetSubscriptionDevice(
      env.DB,
      userId,
      original.revision,
      "owner@example.com",
      Date.now(),
      "Stale removal",
      first.device.deviceId
    ),
    SubscriptionConflictError
  )
  assert.equal(
    decodeReceipt(
      (
        await (
          await sessionRequest(second.device, second.claims.sessionId)
        ).json()
      ).session
    ).status,
    "active"
  )
  await sessionRequest(second.device, second.claims.sessionId, "logout")
  const removed = await getSubscription(env.DB, userId)
  assert.equal(removed.revision, current.revision + 1)
  await sessionRequest(second.device, second.claims.sessionId, "logout")
  assert.equal(
    (await getSubscription(env.DB, userId)).revision,
    removed.revision
  )
})

test("account session devices cannot replace subscription entitlement with legacy license activation, including after logout", async () => {
  const loggedIn = await accountLogin("user_session_no_legacy")
  const key = `PD-${Array(6).fill("AAAAAAAA").join("-")}`
  for (const loggedOut of [false, true]) {
    if (loggedOut)
      await sessionRequest(loggedIn.device, loggedIn.claims.sessionId, "logout")
    const challenge = randomBytes(32).toString("base64url")
    const device = loggedIn.device
    const response = await handleLicenseRequest(
      new Request(`${origin}/api/licenses/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          devicePublicKey: device.publicKeyEncoded,
          challenge,
          signature: sign(
            null,
            Buffer.from(
              JSON.stringify([
                "photodepot-license-v1",
                "activate",
                key,
                device.publicKeyEncoded,
                challenge,
              ])
            ),
            device.privateKey
          ).toString("base64url"),
        }),
      }),
      env,
      "activate"
    )
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /account subscription/)
  }
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

test("explicit account switching retires the foreign legacy assignment without hidden or revived computer slots", async () => {
  const oldUser = "user_legacy_switch_original"
  await assign(oldUser, "regular", Date.now() + 3600_000)
  const device = { ...mac(), deviceName: "Shared Computer" }
  await bindSubscriptionDevice(env.DB, {
    userId: oldUser,
    deviceId: device.deviceId,
    publicKey: device.publicKeyEncoded,
  })
  const before = await getSubscription(env.DB, oldUser)
  const newAccount = await accountLogin("user_legacy_switch_new", device)
  assert.deepEqual(await listAccountDevices(env.DB, oldUser), [])
  assert.equal(
    (await getSubscriptionDevice(env.DB, device.deviceId)).active,
    false
  )
  assert.equal(
    (await getSubscription(env.DB, oldUser)).revision,
    before.revision + 1
  )
  await accountLogin(oldUser)
  await accountLogin(oldUser)
  assert.equal((await listAccountDevices(env.DB, oldUser)).length, 2)
  await sessionRequest(device, newAccount.claims.sessionId, "logout")
  assert.equal((await listAccountDevices(env.DB, oldUser)).length, 2)
  assert.equal(
    (await getSubscriptionDevice(env.DB, device.deviceId)).active,
    false
  )
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

test("pre-existing foreign legacy shadows never count as invisible used slots", async () => {
  const oldUser = "user_shadow_existing"
  await assign(oldUser, "regular", Date.now() + 3600_000)
  const device = mac()
  await accountLogin("user_shadow_current", device)
  // Reproduce the old persisted state directly, before the new cleanup exists.
  await env.DB.prepare(
    "INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active,assignment_revision) SELECT ?,user_id,?,binding_revision,?,1,1 FROM subscriptions WHERE user_id = ?"
  )
    .bind(device.deviceId, device.publicKeyEncoded, Date.now(), oldUser)
    .run()
  assert.deepEqual(await listAccountDevices(env.DB, oldUser), [])
  assert.equal((await getSubscription(env.DB, oldUser)).devices.length, 0)
  await accountLogin(oldUser)
  await accountLogin(oldUser)
  assert.equal((await listAccountDevices(env.DB, oldUser)).length, 2)
  assert.equal((await getSubscription(env.DB, oldUser)).devices.length, 2)
})
