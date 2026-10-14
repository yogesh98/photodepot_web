import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import {
  runSubscriptionReminders,
  subscriptionReminderQueue,
} from "../lib/subscription-reminders.ts"
import {
  setSubscription,
  changeSubscription,
} from "../lib/subscription-store.ts"
import { handleScheduledReminders } from "../functions/api/internal/subscription-reminders.ts"
import { triggerReminders } from "../workers/subscription-reminders.ts"

const day = 86_400_000,
  now = Date.now(),
  token = "test-reminder-trigger-token-at-least-32-characters"
let platform, env, originalFetch, users, lookups
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = {
    ...platform.env,
    WORKOS_CLIENT_ID: "client_reminder_tests",
    WORKOS_API_KEY: "sk_test_reminder_fixture",
    WORKOS_REDIRECT_URI: "https://photodepot.app/api/auth/callback",
    PHOTODEPOT_REMINDER_TOKEN: token,
    RESEND_API_KEY: "re_fixture",
    PHOTODEPOT_EMAIL_FROM: "Photodepot <hello@example.test>",
  }
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8"
    )
    await env.DB.batch(
      unstable_splitSqlQuery(sql).map((statement) => env.DB.prepare(statement))
    )
  }
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(url.origin, "https://api.workos.com")
    const id = url.pathname.split("/").at(-1)
    lookups.push(id)
    const user = users.get(id)
    if (user === "outage") return new Response(null, { status: 503 })
    if (!user)
      return Response.json(
        { message: "User not found", code: "entity_not_found" },
        { status: 404 }
      )
    return Response.json({
      object: "user",
      id,
      email: user.email ?? `${id}@example.test`,
      email_verified: user.verified ?? true,
      first_name: "Customer",
      last_name: null,
      created_at: new Date(now - 5 * day).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
  }
})
beforeEach(async () => {
  users = new Map()
  lookups = []
  await env.DB.batch(
    [
      "DELETE FROM subscription_reminders",
      "DELETE FROM subscription_audit",
      "DELETE FROM account_devices",
      "DELETE FROM subscriptions",
    ].map((sql) => env.DB.prepare(sql))
  )
})
after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})
async function grant(id, end = now + day, type = "trial") {
  users.set(id, {})
  return setSubscription(
    env.DB,
    { userId: id, type, endsAt: end, expectedRevision: 0 },
    "owner@example.test",
    now - 5 * day
  )
}
const rows = () =>
  env.DB.prepare("SELECT * FROM subscription_reminders ORDER BY user_id")
    .all()
    .then((result) => result.results)

test("only active trials in the next48h get one term-specific message; repeated development runs only preview", async () => {
  const dev = { ...env, PHOTODEPOT_ENVIRONMENT: "development" }
  await grant("user_due", now + 2 * day)
  await grant("user_later", now + 2 * day + 1)
  await grant("user_regular", now + day, "regular")
  await grant("user_expired", now - 1)
  const revoked = await grant("user_revoked")
  await changeSubscription(
    env.DB,
    revoked.userId,
    "revoke",
    revoked.revision,
    "owner@example.test",
    undefined,
    now
  )
  const unexpected = () => {
    throw new Error("Dev must never send mail")
  }
  const result = await runSubscriptionReminders(dev, { now, fetch: unexpected })
  assert.equal(result.preview, 1)
  assert.equal(
    (await runSubscriptionReminders(dev, { now, fetch: unexpected })).processed,
    0
  )
  const [mail] = await rows()
  assert.equal(mail.status, "preview")
  assert.equal(mail.attempts, 0)
  assert.ok(mail.message.includes("https://photodepot.app/account"))
  assert.ok(mail.message.includes("No payment"))
  assert.equal(mail.recipient, "user_due@example.test")
  const queue = await subscriptionReminderQueue(dev, now)
  assert.equal(queue.mode, "preview")
  assert.equal(queue.upcoming.length, 3)
})
test("concurrent production jobs send once, preserve provider idempotency, and wait for acknowledgement", async () => {
  await grant("user_due")
  const messages = []
  const transport = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails")
    messages.push(options)
    return Response.json({ id: "email_sent" })
  }
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      runSubscriptionReminders(env, { now, fetch: transport })
    )
  )
  assert.equal(
    results.reduce((sum, r) => sum + r.sent, 0),
    1
  )
  assert.equal(messages.length, 1)
  const [mail] = await rows()
  assert.equal(mail.status, "sent")
  assert.equal(mail.attempts, 1)
  assert.equal(mail.provider_id, "email_sent")
  assert.equal(
    messages[0].headers["Idempotency-Key"],
    `photodepot-trial-ending/${mail.id}`
  )
  assert.equal(
    (await runSubscriptionReminders(env, { now: now + 1000, fetch: transport }))
      .processed,
    0
  )
})
test("unknown provider outcomes retry the identical payload/key and stop outside the24h deduplication window", async () => {
  await grant("user_due", now + 2 * day)
  const calls = []
  const uncertain = async (_url, options) => {
    calls.push(options)
    throw new Error("Disconnected after transmission")
  }
  assert.equal(
    (await runSubscriptionReminders(env, { now, fetch: uncertain })).deferred,
    1
  )
  assert.equal(
    (
      await runSubscriptionReminders(env, {
        now: now + 900_000,
        fetch: uncertain,
      })
    ).deferred,
    1
  )
  assert.equal(calls[0].body, calls[1].body)
  assert.equal(
    calls[0].headers["Idempotency-Key"],
    calls[1].headers["Idempotency-Key"]
  )
  assert.equal(
    (await runSubscriptionReminders(env, { now: now + day, fetch: uncertain }))
      .uncertain,
    1
  )
  assert.equal(calls.length, 2)
})
test("subscription changes or recipient changes cancel stale reminders and deleted/unverified accounts cannot receive email", async () => {
  const subscription = await grant("user_due", now + 2 * day)
  const transport = async () => new Response(null, { status: 503 })
  await runSubscriptionReminders(env, { now, fetch: transport })
  await changeSubscription(
    env.DB,
    subscription.userId,
    "extend",
    subscription.revision,
    "owner@example.test",
    1,
    now
  )
  assert.equal(
    (
      await runSubscriptionReminders(env, {
        now: now + 900_000,
        fetch: transport,
      })
    ).cancelled,
    1
  )
  await grant("user_unverified")
  users.set("user_unverified", { verified: false })
  await grant("user_deleted")
  users.delete("user_deleted")
  const result = await runSubscriptionReminders(env, {
    now,
    fetch: () => {
      throw new Error("Not allowed")
    },
  })
  assert.equal(result.cancelled, 1)
  assert.equal(result.deferred, 1)
  const unverified = (await rows()).find(
    (row) => row.user_id === "user_unverified"
  )
  assert.equal(unverified.attempts, 0)
  assert.equal(unverified.first_attempt_at, null)
})
test("a revocation during lookup prevents transmission; outages stay queued and a expired lease can recover", async () => {
  const subscription = await grant("user_due")
  const saved = globalThis.fetch
  globalThis.fetch = async (...args) => {
    const user = await saved(...args)
    await changeSubscription(
      env.DB,
      subscription.userId,
      "revoke",
      subscription.revision,
      "owner@example.test",
      undefined,
      now
    )
    return user
  }
  try {
    assert.equal(
      (
        await runSubscriptionReminders(env, {
          now,
          fetch: () => {
            throw new Error("Not allowed")
          },
        })
      ).cancelled,
      1
    )
  } finally {
    globalThis.fetch = saved
  }
  await grant("user_outage")
  users.set("user_outage", "outage")
  assert.equal((await runSubscriptionReminders(env, { now })).deferred, 1)
  users.set("user_outage", {})
  await env.DB.prepare(
    "UPDATE subscription_reminders SET status='sending',lease_until=?,lease_token='lost-worker' WHERE user_id='user_outage'"
  )
    .bind(now - 1)
    .run()
  assert.equal(
    (
      await runSubscriptionReminders(env, {
        now,
        fetch: async () => Response.json({ id: "recovered" }),
      })
    ).sent,
    1
  )
})
test("a changed account email cancels an uncertain delivery instead of sending to the old address", async () => {
  await grant("user_changed")
  await runSubscriptionReminders(env, {
    now,
    fetch: async () => {
      throw new Error("Lost response")
    },
  })
  users.set("user_changed", { email: "new@example.test" })
  let sent = false
  const result = await runSubscriptionReminders(env, {
    now: now + 900_000,
    fetch: async () => {
      sent = true
      return Response.json({ id: "unexpected" })
    },
  })
  assert.equal(result.cancelled, 1)
  assert.equal(sent, false)
})
test("known provider rejection is visible and missing production settings fail closed", async () => {
  await grant("user_due")
  assert.equal(
    (
      await runSubscriptionReminders(env, {
        now,
        fetch: async () => new Response(null, { status: 422 }),
      })
    ).failed,
    1
  )
  assert.equal(
    (await rows())[0].last_error,
    "Email provider rejected delivery (422)"
  )
  await assert.rejects(
    runSubscriptionReminders({ ...env, RESEND_API_KEY: "" }, { now }),
    /not configured/
  )
})
test("internal triggers require a dedicated secret and scheduler obeys bounded batches/redirect rules", async () => {
  const origin = "https://photodepot.app"
  assert.equal(
    (
      await handleScheduledReminders(
        new Request(`${origin}/api/internal/subscription-reminders`, {
          method: "POST",
        }),
        env
      )
    ).status,
    401
  )
  assert.equal(
    (
      await handleScheduledReminders(
        new Request(`${origin}/api/internal/subscription-reminders`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
        { ...env, PHOTODEPOT_ENVIRONMENT: "development" }
      )
    ).status,
    200
  )
  assert.equal(
    (
      await handleScheduledReminders(
        new Request(`${origin}/api/internal/subscription-reminders`),
        env
      )
    ).status,
    405
  )
  let calls = 0
  await triggerReminders(
    { PHOTODEPOT_APP_URL: origin, PHOTODEPOT_REMINDER_TOKEN: token },
    async (url, options) => {
      assert.equal(String(url), `${origin}/api/internal/subscription-reminders`)
      assert.equal(options.redirect, "error")
      assert.equal(options.headers.Authorization, `Bearer ${token}`)
      return Response.json({ remaining: ++calls < 3 })
    }
  )
  assert.equal(calls, 3)
  await assert.rejects(
    triggerReminders({
      PHOTODEPOT_APP_URL: "http://evil.test",
      PHOTODEPOT_REMINDER_TOKEN: token,
    }),
    /Invalid/
  )
})
