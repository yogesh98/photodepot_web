import type { Env } from "./cloudflare.ts"

export class ManualAccessRetiredError extends Error {
  constructor() {
    super(
      "Manual access reminders have been retired. Subscription notifications are managed by Stripe."
    )
  }
}

/** Kept for old worker callers; retirement never reads data or sends email. */
export async function runSubscriptionReminders(
  env: Env,
  options: { now?: number; fetch?: typeof fetch } = {}
): Promise<never> {
  void env
  void options
  throw new ManualAccessRetiredError()
}
export async function subscriptionReminderQueue(
  env: Env,
  now = Date.now()
): Promise<never> {
  void env
  void now
  throw new ManualAccessRetiredError()
}
