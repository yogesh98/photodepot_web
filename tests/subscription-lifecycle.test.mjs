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
import { sealData, unsealData } from "iron-session"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import {
  handleAccountLogin,
  handleAdminCallback,
} from "../lib/license-admin-auth.ts"
import {
  handleAccountApproval,
  handleAccountPairing,
} from "../lib/account-pairing.ts"
import { handleDesktopSession } from "../lib/account-sessions.ts"
import { handleAccountSubscription } from "../functions/api/account/subscription.ts"
import { handleAdminSubscriptionRequests } from "../functions/api/admin/subscription-requests.ts"
import { getAccountRequest } from "../lib/account-requests.ts"
import { handleAdminSubscriptions } from "../functions/api/admin/subscriptions.ts"
import {
  getSubscription,
  listSubscriptionAudit,
} from "../lib/subscription-store.ts"
import { LICENSE_GRACE_MS } from "../lib/license-crypto.ts"

const origin = "http://localhost:8788"
const clientId = "client_local_lifecycle"
const organizationId = "org_local_lifecycle_owner"
const cookiePassword = "local-lifecycle-cookie-fixture-at-least-32-characters"
const customerId = "user_local_lifecycle_customer"
const ownerId = "user_local_lifecycle_owner"
const day = 86_400_000
const authority = generateKeyPairSync("ed25519")
const tokenKeys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...tokenKeys.publicKey.export({ format: "jwk" }),
  kid: "local-lifecycle-jwk",
  alg: "RS256",
  use: "sig",
}
const signupAt = Date.now() - 1000
const grantedUntil = Date.now() + 14 * day
let platform,
  env,
  originalFetch,
  expectedVerifier,
  sequence = 0

function workosUser(id) {
  return {
    object: "user",
    id,
    email: `${id}@example.test`,
    email_verified: true,
    first_name: "Local",
    last_name: "Customer",
    created_at: new Date(signupAt).toISOString(),
    updated_at: new Date(signupAt).toISOString(),
  }
}
function jwt(id, admin = false) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: id,
      sid: `session_${id}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(admin ? { org_id: organizationId, role: "owner" } : {}),
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), tokenKeys.privateKey).toString("base64url")}`
}
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
    WORKOS_ADMIN_ORGANIZATION_ID: organizationId,
    WORKOS_COOKIE_PASSWORD: cookiePassword,
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    WORKOS_API_KEY: "sk_test_local_lifecycle",
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: authority.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  }
  for (const filename of (
    await readdir(new URL("../migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8"
    )
    await env.DB.batch(
      unstable_splitSqlQuery(sql).map((statement) => env.DB.prepare(statement))
    )
  }
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    assert.equal(url.origin, "https://api.workos.com")
    if (url.href === `https://api.workos.com/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    if (url.pathname === "/user_management/authenticate") {
      const body = JSON.parse(options.body)
      assert.equal(body.client_id, clientId)
      assert.equal(body.grant_type, "authorization_code")
      assert.equal(body.code_verifier, expectedVerifier)
      assert.equal(body.code, "local-lifecycle-code")
      assert.equal("client_secret" in body, false)
      return Response.json({
        user: workosUser(customerId),
        access_token: jwt(customerId),
        refresh_token: "local-customer-refresh-fixture",
        authentication_method: "MagicAuth",
      })
    }
    assert.equal(
      new Headers(options.headers).get("authorization"),
      `Bearer ${env.WORKOS_API_KEY}`
    )
    if (url.pathname === "/user_management/users")
      return Response.json({
        data: [workosUser(customerId)],
        list_metadata: { before: null, after: null },
      })
    assert.equal(url.pathname, `/user_management/users/${customerId}`)
    return Response.json(workosUser(customerId))
  }
})
after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})

function mac() {
  const keys = generateKeyPairSync("ed25519")
  const bytes = keys.publicKey.export({ format: "der", type: "spki" })
  return {
    ...keys,
    deviceId: createHash("sha256").update(bytes).digest("hex"),
    encodedKey: bytes.toString("base64url"),
    challenge: randomBytes(32).toString("base64url"),
  }
}
function request(path, body, cookie) {
  return new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      "cf-connecting-ip": `local-lifecycle-${sequence++}`,
      "Photodepot-Receipt-Version": "3",
      "Photodepot-Account-Version": "1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
function pairing(device, action = "start", pairingId) {
  const parts =
    action === "start"
      ? [
          "photodepot-account-pairing-v1",
          "start",
          device.deviceId,
          device.encodedKey,
          device.challenge,
        ]
      : [
          "photodepot-account-pairing-v1",
          action,
          pairingId,
          device.deviceId,
          device.challenge,
        ]
  const body = {
    deviceId: device.deviceId,
    challenge: device.challenge,
    ...(action === "start"
      ? { devicePublicKey: device.encodedKey }
      : { pairingId }),
    deviceSignature: sign(
      null,
      Buffer.from(JSON.stringify(parts)),
      device.privateKey
    ).toString("base64url"),
  }
  return handleAccountPairing(
    request(`/api/account/pairing/${action}`, body),
    env,
    action
  )
}
function receipt(envelope, device, status, endsAt = grantedUntil) {
  const bytes = Buffer.from(envelope.payload, "base64url")
  assert.ok(
    verify(
      null,
      bytes,
      authority.publicKey,
      Buffer.from(envelope.signature, "base64url")
    )
  )
  const payload = JSON.parse(bytes)
  assert.equal(payload.deviceId, device.deviceId)
  assert.equal(payload.status, status)
  assert.equal(payload.subscriptionEndsAt, endsAt)
  assert.ok(payload.expiresAt > payload.issuedAt)
  assert.ok(payload.expiresAt - payload.issuedAt <= LICENSE_GRACE_MS)
  for (const field of [
    "userId",
    "email",
    "accessToken",
    "refreshToken",
    "notes",
  ])
    assert.equal(field in payload, false)
  return payload
}
function signedClaims(envelope, device, status) {
  const bytes = Buffer.from(envelope.payload, "base64url")
  assert.ok(
    verify(
      null,
      bytes,
      authority.publicKey,
      Buffer.from(envelope.signature, "base64url")
    )
  )
  const claims = JSON.parse(bytes)
  assert.equal(claims.deviceId, device.deviceId)
  assert.equal(claims.status, status)
  return claims
}
async function verifyMac(device, sessionId, action = "verify") {
  const challenge = randomBytes(32).toString("base64url")
  const body = {
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
        ])
      ),
      device.privateKey
    ).toString("base64url"),
  }
  const response = await handleDesktopSession(
    request(`/api/account/session/${action}`, body),
    env,
    action
  )
  assert.equal(response.status, 200)
  const result = await response.json()
  const claims = signedClaims(
    result.session,
    device,
    action === "logout" ? "revoked" : "active"
  )
  assert.equal(claims.challenge, challenge)
  return { ...result, claims }
}
async function account(cookie, body) {
  const response = await handleAccountSubscription(
    request("/api/account/subscription", body, cookie),
    env
  )
  assert.ok([200, 201].includes(response.status), await response.clone().text())
  return response.json()
}
async function review(cookie, body) {
  return handleAdminSubscriptionRequests(
    request("/api/admin/subscription-requests", body, cookie),
    env
  )
}
async function signIn(started) {
  const code = new URL(started.approvalUrl).searchParams.get("code")
  const login = await handleAccountLogin(
    request(`/api/account/auth/login?code=${code}`),
    env
  )
  assert.equal(login.status, 302)
  const header = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("photodepot-account-login="))
  assert.ok(header)
  assert.equal(header.includes("Secure"), false)
  const loginCookie = header.split(";")[0]
  const transaction = await unsealData(
    loginCookie.slice(loginCookie.indexOf("=") + 1),
    { password: cookiePassword, ttl: 600 }
  )
  expectedVerifier = transaction.codeVerifier
  const callback = await handleAdminCallback(
    request(
      `/api/auth/callback?code=local-lifecycle-code&state=${transaction.state}`,
      undefined,
      loginCookie
    ),
    env
  )
  assert.equal(callback.status, 303)
  assert.equal(
    callback.headers.get("location"),
    new URL(started.approvalUrl).pathname + new URL(started.approvalUrl).search
  )
  const session = callback.headers
    .getSetCookie()
    .find(
      (cookie) =>
        cookie.startsWith("photodepot-account=") &&
        !cookie.includes("Max-Age=0")
    )
  assert.ok(session)
  return session.split(";")[0]
}
async function ownerCookie() {
  const sealed = await sealData(
    {
      version: 1,
      audience: "admin",
      clientId,
      origin,
      accessToken: jwt(ownerId, true),
      refreshToken: "local-owner-refresh-fixture",
      user: { id: ownerId, email: "owner@example.test", emailVerified: true },
    },
    { password: cookiePassword, ttl: 604800 }
  )
  return `photodepot-admin=${sealed}`
}
async function admin(action, expectedRevision, cookie, values = {}) {
  const response = await handleAdminSubscriptions(
    request(
      "/api/admin/subscriptions",
      { action, userId: customerId, expectedRevision, ...values },
      cookie
    ),
    env
  )
  assert.equal(
    response.status,
    action === "set" && expectedRevision === 0 ? 201 : 200
  )
  return (await response.json()).subscription
}
async function approve(started, cookie) {
  const form = await handleAccountApproval(
    new Request(started.approvalUrl, { headers: { cookie } }),
    env
  )
  assert.equal(form.status, 200)
  const csrf = (await form.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.ok(csrf)
  const response = await handleAccountApproval(
    new Request(started.approvalUrl, {
      method: "POST",
      headers: {
        origin,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf }),
    }),
    env
  )
  assert.equal(response.status, 200)
}

test("browser login, free Mac approval, atomic access approval and independent device removal share one lifecycle", async () => {
  const firstMac = mac()
  const startResponse = await pairing(firstMac)
  assert.equal(startResponse.status, 201)
  const started = await startResponse.json()
  assert.equal(new URL(started.approvalUrl).origin, origin)
  const accountCookie = await signIn(started)
  assert.equal(await getSubscription(env.DB, customerId), null)
  assert.deepEqual(await listSubscriptionAudit(env.DB, customerId), [])
  await approve(started, accountCookie)
  const polled = await pairing(firstMac, "poll", started.pairingId)
  assert.equal(polled.status, 200)
  const paired = await polled.json()
  const firstSession = signedClaims(paired.session, firstMac, "active")
  assert.equal(paired.receipt, undefined)
  assert.equal(firstSession.challenge, firstMac.challenge)
  assert.equal(firstSession.userId, customerId)
  assert.equal(firstSession.expiresAt - firstSession.issuedAt, LICENSE_GRACE_MS)
  let view = await account(accountCookie)
  assert.equal(view.access.canUseLocal, false)
  assert.equal(view.access.canHost, false)
  assert.equal(view.access.status, "none")
  assert.equal(view.devices[0].sessionId, firstSession.sessionId)
  assert.equal("subscription" in view, false)
  for (const privateField of ["notes", "audit", "publicKey", "privateKey"])
    assert.equal(privateField in view, false)

  const requestResult = await account(accountCookie, {
    action: "request-renewal",
    message: "Please approve trial access",
  })
  assert.equal(requestResult.created, true)
  assert.equal(
    (await account(accountCookie, { action: "request-renewal" })).request.id,
    requestResult.request.id
  )
  assert.equal(await getSubscription(env.DB, customerId), null)
  const cookie = await ownerCookie()
  const approval = await review(cookie, {
    action: "approve",
    requestId: requestResult.request.id,
    expectedRevision: requestResult.request.revision ?? 1,
    expectedSubscriptionRevision: 0,
    type: "trial",
    endsAt: grantedUntil,
    note: "Owner-approved alpha access",
  })
  assert.equal(approval.status, 200, await approval.clone().text())
  const approved = await approval.json()
  assert.equal(approved.request.status, "resolved")
  assert.equal(approved.subscription.revision, 1)
  const trial = await getSubscription(env.DB, customerId)
  assert.equal(trial.endsAt, grantedUntil)
  assert.equal(trial.startsAt > signupAt, true)
  const verified = await verifyMac(firstMac, firstSession.sessionId)
  const grantClaims = receipt(verified.receipt, firstMac, "active")
  assert.equal(grantClaims.licenseId, trial.id)
  assert.equal(grantClaims.revision, 1)
  assert.equal(grantClaims.challenge, verified.claims.challenge)
  const compatible = signedClaims(
    verified.receipt.collaborationReceipt,
    firstMac,
    "active"
  )
  assert.equal("subscriptionEndsAt" in compatible, false)
  assert.equal(compatible.licenseId, grantClaims.licenseId)
  view = await account(accountCookie)
  assert.equal(view.access.canUseLocal, true)
  assert.equal(view.access.canHost, true)
  assert.equal(view.access.tier, "trial")

  await account(accountCookie, {
    action: "set-reminders",
    enabled: false,
    expectedRevision: trial.revision,
  })
  const optedOut = await getSubscription(env.DB, customerId)
  assert.equal(optedOut.endsAt, trial.endsAt)
  assert.equal(optedOut.remindersEnabled, false)
  assert.equal((await account(accountCookie)).access.canHost, true)
  const nextRequest = await account(accountCookie, {
    action: "request-renewal",
  })
  const beforeAudits = await listSubscriptionAudit(env.DB, customerId)
  const stale = await review(cookie, {
    action: "approve",
    requestId: nextRequest.request.id,
    expectedRevision: 1,
    expectedSubscriptionRevision: trial.revision,
    type: "regular",
    endsAt: grantedUntil + day,
  })
  assert.equal(stale.status, 409)
  assert.deepEqual(await getSubscription(env.DB, customerId), optedOut)
  assert.equal(
    (await getAccountRequest(env.DB, nextRequest.request.id)).status,
    "pending"
  )
  assert.deepEqual(
    await listSubscriptionAudit(env.DB, customerId),
    beforeAudits
  )

  const revoked = await admin("revoke", optedOut.revision, cookie, {
    reason: "Local withdrawal test",
  })
  const freeAgain = await verifyMac(firstMac, firstSession.sessionId)
  assert.equal(freeAgain.receipt, undefined)
  assert.equal(freeAgain.claims.status, "active")
  view = await account(accountCookie)
  assert.equal(view.access.status, "revoked")
  assert.equal(view.access.canHost, false)
  assert.equal(view.access.canUseLocal, false)
  const restored = await admin("restore", revoked.revision, cookie)
  assert.equal(restored.endsAt, trial.endsAt)
  assert.ok((await verifyMac(firstMac, firstSession.sessionId)).receipt)

  const secondMac = mac()
  const secondStart = await (await pairing(secondMac)).json()
  await approve(secondStart, accountCookie)
  const second = await (
    await pairing(secondMac, "poll", secondStart.pairingId)
  ).json()
  const secondSession = signedClaims(second.session, secondMac, "active")
  assert.equal(
    (await getSubscription(env.DB, customerId)).revision,
    restored.revision
  )
  const removed = await handleAdminSubscriptions(
    request(
      "/api/admin/subscriptions",
      {
        action: "remove-device",
        userId: customerId,
        sessionId: firstSession.sessionId,
        expectedSessionRevision: firstSession.revision,
        reason: "Selected computer replacement",
      },
      cookie
    ),
    env
  )
  assert.equal(removed.status, 200, await removed.clone().text())
  assert.equal(
    (await getSubscription(env.DB, customerId)).revision,
    restored.revision
  )
  view = await account(accountCookie)
  assert.equal(view.devices.length, 1)
  assert.equal(view.devices[0].sessionId, secondSession.sessionId)
  const oldLogout = await verifyMac(firstMac, firstSession.sessionId, "logout")
  assert.equal(oldLogout.receipt, undefined)
  assert.ok((await verifyMac(secondMac, secondSession.sessionId)).receipt)
  const historyResponse = await handleAdminSubscriptions(
    request(
      `/api/admin/subscriptions?history=1&userId=${customerId}`,
      undefined,
      cookie
    ),
    env
  )
  const history = await historyResponse.json()
  assert.equal(history.devices.length, 2)
  assert.equal(history.devices.filter((device) => device.current).length, 1)
  assert.equal(history.devices[0].sessionId !== undefined, true)
  assert.equal(
    history.audit.some((entry) => entry.action === "set"),
    true
  )
  assert.equal(
    history.deviceAudit.some(
      (entry) => entry.reason === "Selected computer replacement"
    ),
    true
  )
  assert.equal((await getSubscription(env.DB, customerId)).endsAt, grantedUntil)
})
