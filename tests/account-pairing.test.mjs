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
} from "../lib/subscription-store.ts"
import {
  getSubscriptionDevice,
  resetSubscriptionDevice,
} from "../lib/subscription-devices.ts"

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

function jwt(userId) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  // Customer login needs no membership in the administration organization.
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: userId,
      sid: `session_${userId}`,
      iat: Math.floor(epoch / 1000),
      exp: Math.floor(epoch / 1000) + 3600,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`
}

async function accountCookie(userId, audience = "account") {
  const value = await sealData(
    {
      version: 1,
      audience,
      clientId,
      origin,
      accessToken: jwt(userId),
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
      ? { devicePublicKey: device.publicKeyEncoded }
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
  return handleAccountApproval(
    new Request(`${hostname}${target.pathname}${target.search}`, {
      method,
      headers: { origin: hostname, ...(cookie ? { cookie } : {}), ...headers },
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
