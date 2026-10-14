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
import { handleLicenseRequest } from "../lib/license-api.ts"
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
    PHOTODEPOT_ENVIRONMENT: "development",
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
function receipt(envelope, device, status) {
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
  assert.equal(payload.subscriptionEndsAt, signupAt + 7 * day)
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
async function verifyMac(device, status) {
  const challenge = randomBytes(32).toString("base64url")
  const body = {
    deviceId: device.deviceId,
    challenge,
    signature: sign(
      null,
      Buffer.from(
        JSON.stringify([
          "photodepot-license-v1",
          "verify",
          device.deviceId,
          challenge,
        ])
      ),
      device.privateKey
    ).toString("base64url"),
  }
  const response = await handleLicenseRequest(
    request("/api/licenses/verify", body),
    env,
    "verify"
  )
  assert.equal(response.status, 200)
  const payload = receipt(await response.json(), device, status)
  assert.equal(payload.challenge, challenge)
  return payload
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
  assert.equal(response.status, 200)
  return (await response.json()).subscription
}
async function approve(started, cookie) {
  const response = await handleAccountApproval(
    new Request(started.approvalUrl, {
      method: "POST",
      headers: { origin, cookie },
    }),
    env
  )
  assert.equal(response.status, 200)
}

test("localhost signup, trial, Mac pairing, admin revocation and replacement use one isolated subscription authority", async () => {
  const firstMac = mac()
  const startResponse = await pairing(firstMac)
  assert.equal(startResponse.status, 201)
  const started = await startResponse.json()
  assert.equal(new URL(started.approvalUrl).origin, origin)
  const accountCookie = await signIn(started)
  const trial = await getSubscription(env.DB, customerId)
  assert.equal(trial.startsAt, signupAt)
  assert.equal(trial.endsAt, signupAt + 7 * day)
  assert.equal(trial.type, "trial")
  assert.equal(trial.revision, 1)
  await approve(started, accountCookie)
  const poll = await pairing(firstMac, "poll", started.pairingId)
  assert.equal(poll.status, 200)
  const paired = await poll.json()
  assert.equal(paired.status, "approved")
  const firstReceipt = receipt(paired.receipt, firstMac, "active")
  assert.equal(firstReceipt.licenseId, trial.id)
  assert.equal(firstReceipt.type, "trial")
  assert.equal(firstReceipt.challenge, firstMac.challenge)
  assert.equal(firstReceipt.revision, 2)
  assert.ok(firstReceipt.expiresAt <= trial.endsAt)
  assert.equal((await verifyMac(firstMac, "active")).revision, 2)

  const cookie = await ownerCookie()
  const before = await (
    await handleAdminSubscriptions(
      request("/api/admin/subscriptions", undefined, cookie),
      env
    )
  ).json()
  assert.equal(before.environment, "development")
  assert.equal(before.billingMode, "manual")
  assert.equal(before.overview.activeTrials, 1)
  assert.equal(before.overview.assignedMacs, 1)
  assert.equal(before.users[0].subscription.devices[0].id, firstMac.deviceId)
  const revoked = await admin("revoke", 2, cookie, {
    reason: "Local revocation test",
  })
  assert.equal(revoked.status, "revoked")
  assert.equal((await verifyMac(firstMac, "revoked")).revision, 3)
  // A second authenticated callback cannot revive a revoked trial.
  await signIn(started)
  assert.deepEqual(await getSubscription(env.DB, customerId), revoked)
  const restored = await admin("restore", 3, cookie)
  assert.equal(restored.status, "active")
  assert.equal(restored.endsAt, trial.endsAt)
  assert.equal((await verifyMac(firstMac, "active")).revision, 4)
  const reset = await admin("reset-device", 4, cookie, {
    reason: "Local replacement Mac test",
  })
  assert.deepEqual(reset.devices, [])
  assert.equal(reset.bindingRevision, 2)
  assert.equal((await verifyMac(firstMac, "revoked")).revision, 5)
  assert.equal((await pairing(firstMac, "poll", started.pairingId)).status, 409)

  const replacement = mac()
  const newStart = await pairing(replacement)
  assert.equal(newStart.status, 201)
  const newPairing = await newStart.json()
  await approve(newPairing, accountCookie)
  const replacementPoll = await pairing(
    replacement,
    "poll",
    newPairing.pairingId
  )
  assert.equal(replacementPoll.status, 200)
  const finalReceipt = receipt(
    (await replacementPoll.json()).receipt,
    replacement,
    "active"
  )
  assert.equal(finalReceipt.licenseId, trial.id)
  assert.equal(finalReceipt.revision, 6)
  assert.equal((await verifyMac(firstMac, "revoked")).revision, 6)
  assert.equal((await verifyMac(replacement, "active")).revision, 6)
  const historyResponse = await handleAdminSubscriptions(
    request(
      `/api/admin/subscriptions?history=1&userId=${customerId}`,
      undefined,
      cookie
    ),
    env
  )
  assert.equal(historyResponse.status, 200)
  const history = await historyResponse.json()
  assert.equal(history.subscription.endsAt, trial.endsAt)
  assert.equal(history.subscription.devices[0].id, replacement.deviceId)
  assert.equal(history.devices.length, 2)
  assert.equal(history.devices.filter((device) => device.current).length, 1)
  const audit = await listSubscriptionAudit(env.DB, customerId)
  assert.equal(audit.length, 6)
  assert.equal(
    audit.filter((entry) => entry.action === "initial-trial").length,
    1
  )
  assert.equal(
    audit.filter((entry) => entry.action === "bind-device").length,
    2
  )
  assert.equal(
    audit.find((entry) => entry.action === "revoke").reason,
    "Local revocation test"
  )
  assert.equal(
    audit.find((entry) => entry.action === "reset-device").reason,
    "Local replacement Mac test"
  )
})
