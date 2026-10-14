import { createWorkOS, type User } from "@workos-inc/node"
import type { Env } from "./cloudflare.ts"

export const WORKOS_USER_ID = /^user_[A-Za-z0-9_]{1,120}$/

function workos(env: Env) {
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID)
    throw new Error("WorkOS user management is not configured")
  return createWorkOS({
    apiKey: env.WORKOS_API_KEY,
    clientId: env.WORKOS_CLIENT_ID,
    timeout: 5000,
    maxRetries: 0,
  })
}

export async function listWorkOSUsers(env: Env, after?: string) {
  if (after && !WORKOS_USER_ID.test(after)) throw new TypeError("Invalid page")
  // Do not filter by the administration organization: customers never need
  // administration membership to appear here or receive a subscription.
  const result = await workos(env).userManagement.listUsers({
    limit: 100,
    after,
  })
  return { users: result.data, nextCursor: result.listMetadata.after ?? null }
}

export async function getWorkOSUser(
  env: Env,
  userId: string
): Promise<User | null> {
  if (!WORKOS_USER_ID.test(userId)) throw new TypeError("Invalid WorkOS user")
  try {
    return await workos(env).userManagement.getUser(userId)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404
    )
      return null
    // A missing key, WorkOS outage or invalid credential must not look like a
    // deleted user and must never authorize access from stale data.
    throw error
  }
}
