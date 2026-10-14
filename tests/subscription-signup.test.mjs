import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { handleAccountWebhook } from "../functions/api/account/webhook.ts"
import { activateSignupTrial } from "../lib/subscription-signup.ts"
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
test("signed signup grants exactly seven days from signup without requiring an admin or verified email", async () => {
  const customer = user()
  const response = await handleAccountWebhook(notification(customer), env)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  const trial = await getSubscription(env.DB, customer.id)
  assert.equal(trial.type, "trial")
  assert.equal(trial.status, "active")
  assert.equal(trial.startsAt, Date.parse(customer.created_at))
  assert.equal(trial.endsAt - trial.startsAt, 7 * day)
  assert.equal((await listSubscriptionAudit(env.DB, customer.id)).length, 1)
})
test("parallel delivery, retry and sign-in fallback never extend or duplicate a trial", async () => {
  const customer = user()
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      handleAccountWebhook(notification(customer), env)
    )
  )
  assert.ok(responses.every((response) => response.status === 200))
  const trial = await getSubscription(env.DB, customer.id)
  await activateSignupTrial(env.DB, {
    id: customer.id,
    createdAt: customer.created_at,
  })
  assert.deepEqual(await getSubscription(env.DB, customer.id), trial)
  assert.equal((await listSubscriptionAudit(env.DB, customer.id)).length, 1)
})
test("a late signup event retains the original expired term and cannot replace a revoked or manual grant", async () => {
  const customer = user(new Date(Date.now() - 10 * day).toISOString())
  assert.equal(
    (await handleAccountWebhook(notification(customer), env)).status,
    200
  )
  const trial = await getSubscription(env.DB, customer.id)
  assert.equal(trial.status, "expired")
  const revoked = await changeSubscription(
    env.DB,
    customer.id,
    "revoke",
    trial.revision,
    "owner@example.test"
  )
  await handleAccountWebhook(notification(customer), env)
  assert.deepEqual(await getSubscription(env.DB, customer.id), revoked)
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
})
test("invalid signatures, stale deliveries, altered bodies and invalid signup dates never grant access", async () => {
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
  assert.equal(
    (await handleAccountWebhook(notification(user("invalid-date")), env))
      .status,
    503
  )
  assert.equal(
    (
      await handleAccountWebhook(
        notification(user(new Date(Date.now() + day).toISOString())),
        env
      )
    ).status,
    503
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
