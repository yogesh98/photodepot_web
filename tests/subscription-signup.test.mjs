import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAccountWebhook } from "../functions/api/account/webhook.ts"
import {
  getSubscription,
  listSubscriptionAudit,
  setSubscription,
  changeSubscription,
} from "../lib/subscription-store.ts"

const secret = "test-workos-signup-notification-secret"
const day = 86_400_000
const origin = "https://photodepot.app"
let platform, env
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = {
    ...platform.env,
    WORKOS_CLIENT_ID: "client_signup_tests",
    WORKOS_WEBHOOK_SECRET: secret,
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
})
beforeEach(async () => {
  await env.DB.batch(
    ["DELETE FROM subscription_audit", "DELETE FROM subscriptions"].map((sql) =>
      env.DB.prepare(sql)
    )
  )
})
after(async () => {
  await platform?.dispose()
})
function user(createdAt = new Date(Date.now() - 1000).toISOString()) {
  return {
    object: "user",
    id: "user_signup_customer",
    email: "customer@example.test",
    email_verified: false,
    first_name: null,
    last_name: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
}
function notification(data = user(), options = {}) {
  const payload =
    options.payload ??
    JSON.stringify(
      {
        id: "event_signup",
        event: options.event ?? "user.created",
        data,
        created_at: new Date().toISOString(),
      },
      null,
      2
    )
  const timestamp = options.timestamp ?? Date.now()
  const signature = createHmac("sha256", options.secret ?? secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex")
  return new Request(`${origin}/api/account/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "workos-signature": `t=${timestamp},v1=${signature}`,
      ...options.headers,
    },
    body: payload,
  })
}
test("signed signup notifications never grant alpha access, even for verified accounts", async () => {
  for (const verified of [false, true]) {
    const customer = { ...user(), email_verified: verified }
    const response = await handleAccountWebhook(notification(customer), env)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(await response.json(), { received: true })
    assert.equal(await getSubscription(env.DB, customer.id), null)
    assert.deepEqual(await listSubscriptionAudit(env.DB, customer.id), [])
  }
})
test("parallel signup delivery and retries never create a subscription or audit", async () => {
  const customer = user()
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      handleAccountWebhook(notification(customer), env)
    )
  )
  assert.ok(responses.every((response) => response.status === 200))
  assert.equal(
    (await handleAccountWebhook(notification(customer), env)).status,
    200
  )
  assert.equal(await getSubscription(env.DB, customer.id), null)
  assert.deepEqual(await listSubscriptionAudit(env.DB, customer.id), [])
})
test("signup notifications preserve manually granted trials, revocations and standard access", async () => {
  const customer = user(new Date(Date.now() - 10 * day).toISOString())
  const trial = await setSubscription(
    env.DB,
    {
      userId: customer.id,
      type: "trial",
      endsAt: Date.now() + 3 * day,
      expectedRevision: 0,
    },
    "owner@example.test"
  )
  await handleAccountWebhook(notification(customer), env)
  assert.deepEqual(await getSubscription(env.DB, customer.id), trial)
  assert.equal((await listSubscriptionAudit(env.DB, customer.id)).length, 1)
  const revoked = await changeSubscription(
    env.DB,
    customer.id,
    "revoke",
    trial.revision,
    "owner@example.test"
  )
  await handleAccountWebhook(notification(customer), env)
  assert.deepEqual(await getSubscription(env.DB, customer.id), revoked)
  assert.equal((await listSubscriptionAudit(env.DB, customer.id)).length, 2)
  const manual = await setSubscription(
    env.DB,
    {
      userId: customer.id,
      type: "regular",
      endsAt: Date.now() + 30 * day,
      expectedRevision: revoked.revision,
    },
    "owner@example.test"
  )
  await handleAccountWebhook(notification(customer), env)
  assert.deepEqual(await getSubscription(env.DB, customer.id), manual)
  assert.equal((await listSubscriptionAudit(env.DB, customer.id)).length, 3)
})
test("invalid signatures, stale deliveries and altered bodies are rejected without granting access", async () => {
  for (const options of [
    { secret: "wrong" },
    { timestamp: Date.now() - 600_000 },
    { payload: "not-json" },
    { headers: { "workos-signature": "bad" } },
  ])
    assert.equal(
      (await handleAccountWebhook(notification(user(), options), env)).status,
      401
    )
  assert.equal(await getSubscription(env.DB, "user_signup_customer"), null)
  assert.equal(
    (
      await handleAccountWebhook(notification(), {
        ...env,
        WORKOS_WEBHOOK_SECRET: "",
      })
    ).status,
    503
  )
})
test("signup acknowledgement does not depend on the subscription database or signup date", async () => {
  const unavailableDatabase = new Proxy(
    {},
    {
      get() {
        throw new Error("Signup must not access the subscription database")
      },
    }
  )
  for (const createdAt of [
    "invalid-date",
    new Date(Date.now() + day).toISOString(),
  ])
    assert.equal(
      (
        await handleAccountWebhook(notification(user(createdAt)), {
          ...env,
          DB: unavailableDatabase,
        })
      ).status,
      200
    )
  assert.equal(await getSubscription(env.DB, "user_signup_customer"), null)
})
test("other signed events are acknowledged without changing subscriptions; method and size are bounded", async () => {
  assert.equal(
    (
      await handleAccountWebhook(
        notification(user(), { event: "user.updated" }),
        env
      )
    ).status,
    200
  )
  assert.equal(await getSubscription(env.DB, "user_signup_customer"), null)
  assert.equal(
    (
      await handleAccountWebhook(
        new Request(`${origin}/api/account/webhook`),
        env
      )
    ).status,
    405
  )
  assert.equal(
    (
      await handleAccountWebhook(
        notification(user(), { payload: "x".repeat(9000) }),
        env
      )
    ).status,
    413
  )
})
test("signature verification never normalizes altered whitespace, BOM or invalid UTF-8", async () => {
  const signed = notification()
  const text = await signed.text()
  const headers = signed.headers
  const make = (body) =>
    new Request(`${origin}/api/account/webhook`, {
      method: "POST",
      headers,
      body,
    })
  assert.equal((await handleAccountWebhook(make(text + " "), env)).status, 401)
  assert.equal(
    (await handleAccountWebhook(make("\uFEFF" + text), env)).status,
    401
  )
  const bytes = Buffer.concat([Buffer.from(text), Buffer.from([0xff])])
  assert.equal((await handleAccountWebhook(make(bytes), env)).status, 400)
  assert.equal(await getSubscription(env.DB, "user_signup_customer"), null)
})
