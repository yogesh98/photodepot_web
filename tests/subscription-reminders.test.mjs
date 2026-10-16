import assert from "node:assert/strict"
import { test } from "node:test"
import {
  runSubscriptionReminders,
  subscriptionReminderQueue,
} from "../lib/subscription-reminders.ts"
import { handleScheduledReminders } from "../functions/api/internal/subscription-reminders.ts"
const token = "retired-reminder-scheduler-token-at-least-32-characters"
const forbidden = () => {
  throw new Error("Retired reminders must not access storage or send mail")
}
const env = {
  PHOTODEPOT_REMINDER_TOKEN: token,
  DB: { prepare: forbidden, batch: forbidden },
  RESEND_API_KEY: "re_unused",
  PHOTODEPOT_EMAIL_FROM: "Photodepot <hello@example.test>",
}
test("retired reminders cannot read customer data, queue messages or send mail", async () => {
  await assert.rejects(
    runSubscriptionReminders(env, { fetch: forbidden }),
    /retired/
  )
  await assert.rejects(subscriptionReminderQueue(env), /retired/)
})
test("legacy scheduler authenticates then returns a permanent retirement response", async () => {
  const request = (method, authorization) =>
    new Request("https://photodepot.app/api/internal/subscription-reminders", {
      method,
      headers: authorization ? { authorization } : {},
    })
  assert.equal(
    (await handleScheduledReminders(request("GET"), env)).status,
    405
  )
  assert.equal(
    (await handleScheduledReminders(request("POST"), env)).status,
    401
  )
  assert.equal(
    (await handleScheduledReminders(request("POST", "Bearer incorrect"), env))
      .status,
    401
  )
  const result = await handleScheduledReminders(
    request("POST", `Bearer ${token}`),
    env
  )
  assert.equal(result.status, 410)
  assert.match((await result.json()).error, /managed by Stripe/)
})

test("the retired scheduler worker never sends an outbound job", async (t) => {
  const { default: worker } =
    await import("../workers/subscription-reminders.ts")
  t.mock.method(globalThis, "fetch", forbidden)
  await worker.scheduled({}, env)
  assert.equal(worker.fetch().status, 404)
})
