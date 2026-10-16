import { timingSafeEqual } from "node:crypto"
import type { PagesFunction } from "@cloudflare/workers-types"
import { json, type Env } from "../../../lib/cloudflare.ts"

export async function handleScheduledReminders(request: Request, env: Env) {
  if (request.method !== "POST") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "POST")
    return response
  }
  if (
    !env.PHOTODEPOT_REMINDER_TOKEN ||
    env.PHOTODEPOT_REMINDER_TOKEN.length < 32
  )
    return json({ error: "Reminder scheduler is not configured." }, 503)
  const expected = Buffer.from(`Bearer ${env.PHOTODEPOT_REMINDER_TOKEN}`),
    supplied = Buffer.from(request.headers.get("authorization") ?? "")
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return json({ error: "Unauthorized." }, 401)
  return json(
    {
      error:
        "Manual access reminders have been retired. Subscription billing notifications are managed by Stripe.",
    },
    410
  )
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleScheduledReminders(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
