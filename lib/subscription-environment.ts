import type { Env } from "./cloudflare.ts"

export type SubscriptionEnvironment = "production" | "development"

export function subscriptionEnvironment(env: Env): SubscriptionEnvironment {
  const value = env.PHOTODEPOT_ENVIRONMENT ?? "production"
  if (value !== "production" && value !== "development")
    throw new Error(
      "Choose production or development for PHOTODEPOT_ENVIRONMENT."
    )
  return value
}
