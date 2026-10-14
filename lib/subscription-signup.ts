import type { D1Database } from "@cloudflare/workers-types"
import { ensureInitialTrial } from "./subscription-store.ts"

/** A delayed notification must never restart the signup trial. */
export async function activateSignupTrial(
  database: D1Database,
  user: { id: string; createdAt: string },
  now = Date.now()
) {
  const startedAt = Date.parse(user.createdAt)
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > now)
    throw new TypeError("Invalid account signup date.")
  return ensureInitialTrial(database, user.id, startedAt, now)
}
