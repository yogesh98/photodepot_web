import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { after, before, beforeEach, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import { runSubscriptionReminders } from "../lib/subscription-reminders.ts"
import { setSubscription } from "../lib/subscription-store.ts"

const day = 86_400_000
const now = Date.now()
const customerId = "user_reminder_delivery_guard"
let platform, env, originalFetch
function userResponse() {
  return Response.json({
    object: "user",
    id: customerId,
    email: "customer@example.test",
    email_verified: true,
    first_name: "Customer",
    last_name: null,
    created_at: new Date(now - 5 * day).toISOString(),
    updated_at: new Date(now).toISOString(),
  })
}
function workosOnly(input) {
  const url = new URL(String(input))
  assert.equal(
    url.href,
    `https://api.workos.com/user_management/users/${customerId}`
  )
  return userResponse()
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
    PHOTODEPOT_ENVIRONMENT: "production",
    WORKOS_CLIENT_ID: "client_reminder_delivery_guards",
    WORKOS_API_KEY: "sk_test_delivery_guard_fixture",
    WORKOS_REDIRECT_URI: "https://photodepot.app/api/auth/callback",
    RESEND_API_KEY: "re_delivery_guard_fixture",
    PHOTODEPOT_EMAIL_FROM: "Photodepot <trial@example.test>",
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
})
beforeEach(async () => {
  globalThis.fetch = async (input) => workosOnly(input)
  await env.DB.batch(
    [
      "DELETE FROM subscription_reminders",
      "DELETE FROM subscription_audit",
      "DELETE FROM account_devices",
      "DELETE FROM subscriptions",
    ].map((sql) => env.DB.prepare(sql))
  )
  await setSubscription(
    env.DB,
    {
      userId: customerId,
      type: "trial",
      endsAt: now + 2 * day,
      expectedRevision: 0,
    },
    "owner@example.test",
    now - 5 * day
  )
})
after(async () => {
  globalThis.fetch = originalFetch
  await platform?.dispose()
})
const row = () =>
  env.DB.prepare("SELECT * FROM subscription_reminders WHERE user_id = ?")
    .bind(customerId)
    .first()

test("a worker that loses its lease during WorkOS lookup cannot transmit after the replacement worker sends", async () => {
  let enterLookup,
    releaseLookup,
    lookups = 0
  const entered = new Promise((resolve) => {
    enterLookup = resolve
  })
  const release = new Promise((resolve) => {
    releaseLookup = resolve
  })
  globalThis.fetch = async (input) => {
    if (++lookups === 1) {
      enterLookup()
      await release
    }
    return workosOnly(input)
  }
  const providers = []
  const stalled = runSubscriptionReminders(env, {
    now,
    fetch: async () => {
      providers.push("lost-lease")
      return Response.json({ id: "stale-provider-send" })
    },
  })
  await entered
  try {
    const replacement = await runSubscriptionReminders(env, {
      now: now + 120_001,
      fetch: async () => {
        providers.push("current-lease")
        return Response.json({ id: "replacement-provider-send" })
      },
    })
    assert.equal(replacement.sent, 1)
  } finally {
    releaseLookup()
  }
  await stalled
  assert.deepEqual(providers, ["current-lease"])
  const current = await row()
  assert.equal(current.status, "sent")
  assert.equal(current.attempts, 1)
  assert.equal(current.provider_id, "replacement-provider-send")
})

test("an ambiguous retry keeps the exact original sender, recipient and body when sender configuration changes", async () => {
  const calls = []
  await runSubscriptionReminders(env, {
    now,
    fetch: async (_url, options) => {
      calls.push(options)
      throw new Error("Provider response lost")
    },
  })
  const retry = await runSubscriptionReminders(
    {
      ...env,
      PHOTODEPOT_EMAIL_FROM: "Photodepot <changed-sender@example.test>",
    },
    {
      now: now + 900_000,
      fetch: async (_url, options) => {
        calls.push(options)
        return Response.json({ id: "acknowledged-retry" })
      },
    }
  )
  assert.equal(retry.sent, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body, calls[1].body)
  assert.equal(
    calls[0].headers["Idempotency-Key"],
    calls[1].headers["Idempotency-Key"]
  )
  const payload = JSON.parse(calls[1].body)
  assert.equal(payload.from, env.PHOTODEPOT_EMAIL_FROM)
  assert.deepEqual(payload.to, ["customer@example.test"])
  assert.equal((await row()).status, "sent")
})

test("rotating provider credentials stops an ambiguous retry because its idempotency namespace may change", async () => {
  let calls = 0
  await runSubscriptionReminders(env, {
    now,
    fetch: async () => {
      calls++
      throw new Error("Provider response lost")
    },
  })
  const retry = await runSubscriptionReminders(
    { ...env, RESEND_API_KEY: "re_different_account_fixture" },
    {
      now: now + 900_000,
      fetch: async () => {
        calls++
        return Response.json({ id: "unsafe-new-namespace-send" })
      },
    }
  )
  assert.equal(calls, 1)
  assert.equal(retry.uncertain, 1)
  assert.equal((await row()).status, "uncertain")
})
