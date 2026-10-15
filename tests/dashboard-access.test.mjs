import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { after, before, beforeEach, test } from "node:test"
import { sealData, unsealData } from "iron-session"
import {
  handleDashboardAccess,
  onRequest,
} from "../functions/api/account/dashboard-access.ts"

const origin = "https://photodepot.app"
const clientId = "client_dashboard_access"
const organizationId = "org_dashboard_admin"
const password = "dashboard-access-cookie-password-at-least-32-characters"
const user = { id: "user_dashboard_customer", email: "customer@example.test" }
const admin = { id: "user_dashboard_owner", email: "owner@example.test" }
const env = {
  WORKOS_CLIENT_ID: clientId,
  WORKOS_ADMIN_ORGANIZATION_ID: organizationId,
  WORKOS_COOKIE_PASSWORD: password,
  WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
  WORKOS_API_KEY: "sk_test_dashboard_access",
}
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "dashboard-access-key",
  alg: "RS256",
  use: "sig",
}
let originalFetch, memberships, membershipRequests, membershipFailure, refreshes

function jwt(identity, claims = {}, key = rsa.privateKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid })
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com",
      client_id: clientId,
      sub: identity.id,
      sid: "session_dashboard_customer",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    })
  ).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`
}

async function sessionCookie(
  audience = "account",
  identity = user,
  claims = {}
) {
  return `__Host-photodepot-${audience}=${await sealData(
    {
      version: 1,
      audience,
      clientId,
      origin,
      accessToken: jwt(identity, claims),
      refreshToken: "refresh-dashboard-customer",
      user: { ...identity, emailVerified: true },
    },
    { password, ttl: 604800 }
  )}`
}

function membership(changes = {}) {
  return {
    object: "organization_membership",
    id: "om_dashboard_customer",
    organization_id: organizationId,
    organization_name: "Photodepot Administration",
    user_id: user.id,
    status: "active",
    role: { slug: "owner" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...changes,
  }
}

function request(query = "", cookie, method = "GET") {
  return new Request(`${origin}/api/account/dashboard-access${query}`, {
    method,
    headers: cookie ? { cookie } : {},
  })
}

before(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input))
    if (url.pathname === `/sso/jwks/${clientId}`)
      return Response.json({ keys: [jwk] })
    if (url.pathname === "/user_management/authenticate") {
      const body = JSON.parse(options.body)
      refreshes.push(body)
      assert.equal(body.refresh_token, "refresh-dashboard-customer")
      assert.equal("organization_id" in body, false)
      return Response.json({
        user: { id: user.id, email: user.email, email_verified: true },
        access_token: jwt(user),
        refresh_token: "refresh-dashboard-rotated",
        authentication_method: "MagicAuth",
      })
    }
    assert.equal(url.origin, "https://api.workos.com")
    assert.equal(url.pathname, "/user_management/organization_memberships")
    assert.equal(url.searchParams.get("user_id"), user.id)
    assert.equal(url.searchParams.get("organization_id"), organizationId)
    assert.equal(url.searchParams.get("statuses"), "active")
    assert.equal(
      new Headers(options.headers).get("authorization"),
      `Bearer ${env.WORKOS_API_KEY}`
    )
    membershipRequests.push(url)
    if (membershipFailure === "network") throw new Error("WorkOS unavailable")
    if (membershipFailure)
      return Response.json(
        { message: "WorkOS unavailable" },
        { status: membershipFailure }
      )
    return Response.json({
      data: memberships,
      list_metadata: { before: null, after: null },
    })
  }
})

beforeEach(() => {
  memberships = []
  membershipRequests = []
  membershipFailure = undefined
  refreshes = []
})

after(() => {
  globalThis.fetch = originalFetch
})

test("dashboard access authenticates only the selected audience", async () => {
  const adminCookie = await sessionCookie("admin", admin, {
    org_id: organizationId,
    role: "owner",
  })
  const accountCookie = await sessionCookie()
  for (const [query, cookie] of [
    ["", undefined],
    ["?dashboard=admin", accountCookie],
    ["?dashboard=individual", adminCookie],
  ]) {
    const response = await handleDashboardAccess(request(query, cookie), env)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  assert.equal(membershipRequests.length, 0)
})

test("signed organization Owners can switch from the admin dashboard", async () => {
  for (const claims of [
    { org_id: organizationId, role: "owner" },
    { org_id: organizationId, role: "member", roles: ["member", "owner"] },
  ]) {
    const response = await onRequest({
      request: request(
        "?dashboard=admin",
        await sessionCookie("admin", admin, claims)
      ),
      env,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      user: admin,
      canAccessAdmin: true,
    })
    assert.equal(response.headers.get("cache-control"), "private, no-store")
  }
  assert.equal(membershipRequests.length, 0)
})

test("the admin capability uses the same organization and exact Owner role as admin APIs", async () => {
  for (const claims of [
    { org_id: "org_another", role: "owner" },
    { org_id: organizationId, role: "member" },
    { org_id: organizationId, role: "Owner" },
    { org_id: organizationId, roles: ["org-owner"] },
  ]) {
    const response = await handleDashboardAccess(
      request("?dashboard=admin", await sessionCookie("admin", admin, claims)),
      env
    )
    assert.equal(response.status, 403)
  }
})

test("individual dashboards discover their own live active Owner membership", async () => {
  for (const roles of [
    { role: { slug: "owner" } },
    {
      role: { slug: "member" },
      roles: [{ slug: "member" }, { slug: "owner" }],
    },
  ]) {
    memberships = [membership(roles)]
    const response = await handleDashboardAccess(
      request("?dashboard=individual", await sessionCookie()),
      env
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { user, canAccessAdmin: true })
  }
  assert.equal(membershipRequests.length, 2)
})

test("removed, inactive, pending, other-user and other-organization memberships hide the switcher", async () => {
  for (const records of [
    [],
    [membership({ status: "inactive" })],
    [membership({ status: "pending" })],
    [membership({ organization_id: "org_another" })],
    [membership({ user_id: admin.id })],
    [membership({ role: { slug: "member" } })],
    [membership({ role: { slug: "Owner" } })],
    [membership({ role: { slug: "member" }, roles: [{ slug: "org-owner" }] })],
  ]) {
    memberships = records
    // Organization claims are not a substitute for the account's live membership.
    const cookie = await sessionCookie("account", user, {
      org_id: organizationId,
      role: "owner",
    })
    const response = await handleDashboardAccess(request("", cookie), env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { user, canAccessAdmin: false })
  }
})

test("an unrelated Owner cookie cannot expose the admin switcher for an individual user", async () => {
  const cookie = `${await sessionCookie()}; ${await sessionCookie("admin", admin, { org_id: organizationId, role: "owner" })}`
  const response = await handleDashboardAccess(
    request("?dashboard=individual", cookie),
    env
  )
  assert.deepEqual(await response.json(), { user, canAccessAdmin: false })
  const adminResponse = await handleDashboardAccess(
    request("?dashboard=admin", cookie),
    env
  )
  assert.deepEqual(await adminResponse.json(), {
    user: admin,
    canAccessAdmin: true,
  })
})

test("missing administration configuration preserves account access and hides the switcher", async () => {
  const cookie = await sessionCookie()
  for (const configuration of [
    { WORKOS_API_KEY: undefined },
    { WORKOS_ADMIN_ORGANIZATION_ID: undefined },
    { WORKOS_ADMIN_ORGANIZATION_ID: "invalid-org" },
  ]) {
    const response = await handleDashboardAccess(request("", cookie), {
      ...env,
      ...configuration,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { user, canAccessAdmin: false })
  }
  assert.equal(membershipRequests.length, 0)
  const missingAccountConfig = await handleDashboardAccess(
    request("", cookie),
    { ...env, WORKOS_CLIENT_ID: undefined }
  )
  assert.equal(missingAccountConfig.status, 503)
})

test("membership errors and outages fail closed without blocking the individual dashboard", async () => {
  memberships = [membership()]
  for (const failure of [401, 403, 429, 503, "network"]) {
    membershipFailure = failure
    const response = await handleDashboardAccess(
      request("", await sessionCookie()),
      env
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { user, canAccessAdmin: false })
  }
})

test("expired account sessions refresh and propagate their rotated cookie", async () => {
  memberships = [membership()]
  const response = await handleDashboardAccess(
    request(
      "",
      await sessionCookie("account", user, {
        exp: Math.floor(Date.now() / 1000) - 60,
      })
    ),
    env
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { user, canAccessAdmin: true })
  assert.equal(refreshes.length, 1)
  const header = response.headers.get("set-cookie")
  assert.match(header, /^__Host-photodepot-account=/)
  const sealed = header.split(";")[0].split("=")[1]
  const session = await unsealData(sealed, { password, ttl: 604800 })
  assert.equal(session.audience, "account")
  assert.equal(session.refreshToken, "refresh-dashboard-rotated")
})

test("dashboard access rejects unknown dashboards and non-GET requests", async () => {
  const invalid = await handleDashboardAccess(
    request("?dashboard=everyone"),
    env
  )
  assert.equal(invalid.status, 400)
  const post = await handleDashboardAccess(request("", undefined, "POST"), env)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get("allow"), "GET")
  assert.equal(membershipRequests.length, 0)
})
