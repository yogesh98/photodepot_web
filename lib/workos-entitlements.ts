import { createWorkOS } from "@workos-inc/node"
import type { D1Database } from "@cloudflare/workers-types"
import { sealData, unsealData } from "iron-session"
import { errors, type JWTPayload } from "jose"
import type { Env } from "./cloudflare.ts"
import { verifyWorkOSAccessToken } from "./license-admin-auth.ts"

export interface WorkOSEntitlement {
  userId: string
  organizationId: string
  enabled: boolean
  issuedAt: number
  expiresAt: number
  revision: number
}
interface SnapshotRow {
  user_id: string
  organization_id: string
  context: string
  enabled: number
  issued_at: number
  expires_at: number
  revision: number
}
interface BillingSessionRow {
  user_id: string
  session_id: string
  encrypted_tokens: string
  operation_token: string | null
  lease_until: number
  reauth_needed: number
}
interface Tokens {
  version: 1
  purpose: "photodepot-billing-auth"
  clientId: string
  userId: string
  organizationId: string
  sessionId: string
  accessToken: string
  refreshToken: string
}
interface RefreshResult {
  accessToken: string
  refreshToken: string
  user: { id: string; emailVerified: boolean }
}
export interface WorkOSEntitlementDependencies {
  workos?: {
    userManagement: {
      authenticateWithRefreshToken(options: {
        refreshToken: string
        organizationId: string
      }): Promise<RefreshResult>
    }
  }
  verifyAccessToken?: typeof verifyWorkOSAccessToken
}
export interface WorkOSEntitlementOptions extends WorkOSEntitlementDependencies {
  forceRefresh?: boolean
  now?: number
}
export class WorkOSEntitlementUnavailableError extends Error {}
class InvalidBillingCredentialsError extends WorkOSEntitlementUnavailableError {}

function terminalTokenFailure(error: unknown) {
  return (
    error instanceof errors.JOSEError &&
    [
      "ERR_JWT_CLAIM_VALIDATION_FAILED",
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      "ERR_JWS_INVALID",
      "ERR_JWT_INVALID",
      "ERR_JOSE_ALG_NOT_ALLOWED",
    ].includes(error.code)
  )
}
function terminalRefreshFailure(error: unknown) {
  if (!error || typeof error !== "object") return false
  // Network errors, timeouts, rate limits and upstream failures are retryable.
  // Other OAuth/client failures cannot repair this stored grant by retrying it.
  const status = "status" in error ? error.status : undefined
  if (typeof status === "number")
    return status >= 400 && status < 500 && ![408, 429].includes(status)
  return (
    ("error" in error &&
      typeof error.error === "string" &&
      [
        "invalid_grant",
        "invalid_client",
        "invalid_request",
        "unauthorized_client",
        "access_denied",
      ].includes(error.error)) ||
    ("code" in error && error.code === "invalid_grant")
  )
}

function configuration(env: Env) {
  const clientId = env.WORKOS_CLIENT_ID
  const password = env.WORKOS_COOKIE_PASSWORD
  const entitlement = env.PHOTODEPOT_WORKOS_ENTITLEMENT ?? "photodepot-standard"
  if (
    !clientId ||
    !/^client_[A-Za-z0-9_]+$/.test(clientId) ||
    !password ||
    password.length < 32 ||
    !entitlement ||
    entitlement.length > 128
  )
    throw new WorkOSEntitlementUnavailableError(
      "Billing access is not configured."
    )
  return {
    clientId,
    password,
    entitlement,
    context: JSON.stringify([clientId, entitlement]),
  }
}
export async function hasWorkOSBillingSession(db: D1Database, userId: string) {
  return Boolean(
    await db
      .prepare(
        "SELECT 1 FROM workos_billing_sessions WHERE user_id = ? AND reauth_needed = 0"
      )
      .bind(userId)
      .first()
  )
}
function snapshot(row: SnapshotRow): WorkOSEntitlement {
  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    enabled: row.enabled === 1,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revision: row.revision,
  }
}
async function readSnapshot(db: D1Database, userId: string) {
  return db
    .prepare("SELECT * FROM workos_entitlements WHERE user_id = ?")
    .bind(userId)
    .first<SnapshotRow>()
}
export async function billingOrganization(env: Env, userId: string) {
  const row = await env.DB.prepare(
    "SELECT workos_organization_id, stripe_customer_id FROM stripe_customers WHERE user_id = ?"
  )
    .bind(userId)
    .first<{
      workos_organization_id: string | null
      stripe_customer_id: string | null
    }>()
  if (!row?.workos_organization_id || !row.stripe_customer_id) return null
  if (
    !/^org_[A-Za-z0-9_]+$/.test(row.workos_organization_id) ||
    row.workos_organization_id === env.WORKOS_ADMIN_ORGANIZATION_ID
  )
    throw new WorkOSEntitlementUnavailableError("Invalid billing organization.")
  return {
    organizationId: row.workos_organization_id,
    customerId: row.stripe_customer_id,
  }
}
function proof(
  claims: JWTPayload,
  tokens: Tokens,
  entitlement: string
): Omit<WorkOSEntitlement, "revision"> {
  if (
    claims.sub !== tokens.userId ||
    claims.sid !== tokens.sessionId ||
    claims.org_id !== tokens.organizationId ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    (claims.entitlements !== undefined &&
      (!Array.isArray(claims.entitlements) ||
        claims.entitlements.some((slug) => typeof slug !== "string")))
  )
    throw new InvalidBillingCredentialsError("Invalid billing access proof.")
  return {
    userId: tokens.userId,
    organizationId: tokens.organizationId,
    enabled:
      Array.isArray(claims.entitlements) &&
      claims.entitlements.includes(entitlement),
    issuedAt: claims.iat! * 1000,
    expiresAt: claims.exp! * 1000,
  }
}
function snapshotStatement(
  db: D1Database,
  value: Omit<WorkOSEntitlement, "revision">,
  context: string,
  guard: string,
  bindings: (string | number)[]
) {
  return db
    .prepare(
      `INSERT INTO workos_entitlements (user_id, organization_id, context, enabled, issued_at, expires_at, revision)
      SELECT ?, ?, ?, ?, ?, ?, 1 WHERE ${guard}
      ON CONFLICT(user_id) DO UPDATE SET
      organization_id = excluded.organization_id, context = excluded.context, enabled = excluded.enabled,
      issued_at = excluded.issued_at, expires_at = excluded.expires_at,
      revision = workos_entitlements.revision + CASE WHEN
        workos_entitlements.organization_id != excluded.organization_id OR
        workos_entitlements.context != excluded.context OR
        workos_entitlements.enabled != excluded.enabled OR
        workos_entitlements.issued_at != excluded.issued_at OR
        workos_entitlements.expires_at != excluded.expires_at THEN 1 ELSE 0 END`
    )
    .bind(
      value.userId,
      value.organizationId,
      context,
      value.enabled ? 1 : 0,
      value.issuedAt,
      value.expiresAt,
      ...bindings
    )
}

async function requireReauthorization(
  db: D1Database,
  userId: string,
  token: string,
  now: number
) {
  const result = await db.batch([
    db
      .prepare(
        `UPDATE workos_billing_sessions SET reauth_needed = 1, updated_at = ?
      WHERE user_id = ? AND operation_token = ? AND lease_until > ?`
      )
      .bind(now, userId, token, now),
    db
      .prepare(
        `UPDATE workos_entitlements SET enabled = 0, expires_at = MIN(expires_at, ?), revision = revision + 1
      WHERE user_id = ? AND EXISTS (SELECT 1 FROM workos_billing_sessions WHERE user_id = ? AND operation_token = ? AND reauth_needed = 1)`
      )
      .bind(now, userId, userId, token),
  ])
  if (result[0].meta.changes !== 1)
    throw new WorkOSEntitlementUnavailableError("Billing access lease expired.")
}

/** Persist an independently authenticated session; browser credentials never enter this store. */
export async function storeWorkOSBillingSession(
  env: Env,
  input: {
    userId: string
    organizationId: string
    browserSessionId: string
    accessToken: string
    refreshToken: string
  },
  options: WorkOSEntitlementDependencies & { now?: number } = {}
) {
  const now = options.now ?? Date.now()
  const config = configuration(env)
  const organization = await billingOrganization(env, input.userId)
  if (!organization || organization.organizationId !== input.organizationId)
    throw new WorkOSEntitlementUnavailableError("Billing account changed.")
  const claims = await (options.verifyAccessToken ?? verifyWorkOSAccessToken)(
    input.accessToken,
    config.clientId,
    now
  )
  if (
    typeof claims.sid !== "string" ||
    claims.sid === input.browserSessionId ||
    !input.refreshToken ||
    input.refreshToken.length > 4000
  )
    throw new WorkOSEntitlementUnavailableError(
      "A separate billing sign-in is required."
    )
  const tokens: Tokens = {
    version: 1,
    purpose: "photodepot-billing-auth",
    clientId: config.clientId,
    userId: input.userId,
    organizationId: input.organizationId,
    sessionId: claims.sid,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
  }
  const value = proof(claims, tokens, config.entitlement)
  const encrypted = await sealData(tokens, {
    password: config.password,
    ttl: 0,
  })
  // A new authorization cannot replace credentials during a rotating refresh.
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workos_billing_sessions (user_id, session_id, encrypted_tokens, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      session_id = excluded.session_id, encrypted_tokens = excluded.encrypted_tokens,
      reauth_needed = 0, operation_token = NULL, lease_until = 0, updated_at = excluded.updated_at
      WHERE workos_billing_sessions.lease_until <= ?`
    ).bind(input.userId, tokens.sessionId, encrypted, now, now),
    snapshotStatement(
      env.DB,
      value,
      config.context,
      "EXISTS (SELECT 1 FROM workos_billing_sessions WHERE user_id = ? AND session_id = ? AND encrypted_tokens = ? AND reauth_needed = 0)",
      [input.userId, tokens.sessionId, encrypted]
    ),
  ])
  if (result[0].meta.changes !== 1)
    throw new WorkOSEntitlementUnavailableError(
      "Billing access is being refreshed. Try again."
    )
  return snapshot((await readSnapshot(env.DB, input.userId))!)
}

/** Verified JWTs authorize feature access; no Stripe invoice lifecycle is reconstructed. */
export async function getWorkOSEntitlement(
  env: Env,
  userId: string,
  options: WorkOSEntitlementOptions = {}
): Promise<WorkOSEntitlement | null> {
  const started = Date.now()
  const now = options.now ?? started
  const clock = () => now + Math.max(0, Date.now() - started)
  const session = await env.DB.prepare(
    "SELECT * FROM workos_billing_sessions WHERE user_id = ? AND reauth_needed = 0"
  )
    .bind(userId)
    .first<BillingSessionRow>()
  if (!session) return null
  const organization = await billingOrganization(env, userId)
  if (!organization) return null
  const config = configuration(env)
  const cached = await readSnapshot(env.DB, userId)
  if (
    !options.forceRefresh &&
    cached?.organization_id === organization.organizationId &&
    cached.context === config.context &&
    cached.expires_at > clock()
  )
    return snapshot(cached)
  const token = crypto.randomUUID()
  const acquired = await env.DB.prepare(
    `UPDATE workos_billing_sessions SET operation_token = ?, lease_until = ?
    WHERE user_id = ? AND reauth_needed = 0 AND lease_until <= ?`
  )
    .bind(token, clock() + 30_000, userId, clock())
    .run()
  if (acquired.meta.changes !== 1)
    throw new WorkOSEntitlementUnavailableError(
      "Billing access is being refreshed. Try again."
    )
  try {
    const current = await env.DB.prepare(
      "SELECT * FROM workos_billing_sessions WHERE user_id = ? AND operation_token = ?"
    )
      .bind(userId, token)
      .first<BillingSessionRow>()
    if (!current)
      throw new WorkOSEntitlementUnavailableError(
        "Billing access lease expired."
      )
    let tokens: Tokens
    try {
      tokens = await unsealData<Tokens>(current.encrypted_tokens, {
        password: config.password,
        ttl: 0,
      })
    } catch {
      throw new InvalidBillingCredentialsError(
        "Billing sign-in must be renewed."
      )
    }
    if (
      !tokens ||
      typeof tokens !== "object" ||
      tokens.version !== 1 ||
      tokens.purpose !== "photodepot-billing-auth" ||
      tokens.clientId !== config.clientId ||
      tokens.userId !== userId ||
      tokens.sessionId !== current.session_id ||
      tokens.organizationId !== organization.organizationId ||
      typeof tokens.accessToken !== "string" ||
      !tokens.accessToken ||
      tokens.accessToken.length > 16000 ||
      typeof tokens.refreshToken !== "string" ||
      !tokens.refreshToken ||
      tokens.refreshToken.length > 4000
    )
      throw new InvalidBillingCredentialsError(
        "Billing sign-in must be renewed."
      )
    const verify = options.verifyAccessToken ?? verifyWorkOSAccessToken
    let claims: JWTPayload | undefined
    if (!options.forceRefresh) {
      try {
        claims = await verify(tokens.accessToken, config.clientId, clock())
      } catch (error) {
        if (!(error instanceof errors.JWTExpired)) throw error
      }
    }
    if (!claims) {
      let refreshed: RefreshResult
      try {
        const workos =
          options.workos ??
          createWorkOS({
            clientId: config.clientId,
            timeout: 5000,
            maxRetries: 0,
          })
        refreshed = await workos.userManagement.authenticateWithRefreshToken({
          refreshToken: tokens.refreshToken,
          organizationId: organization.organizationId,
        })
      } catch (error) {
        if (terminalRefreshFailure(error))
          throw new InvalidBillingCredentialsError(
            "Billing sign-in must be renewed."
          )
        throw error
      }
      if (
        !refreshed.user.emailVerified ||
        refreshed.user.id !== userId ||
        typeof refreshed.refreshToken !== "string" ||
        !refreshed.refreshToken ||
        refreshed.refreshToken.length > 4000 ||
        typeof refreshed.accessToken !== "string" ||
        refreshed.accessToken.length > 16000
      )
        throw new InvalidBillingCredentialsError("Billing account mismatch.")
      tokens = {
        ...tokens,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
      }
      // Rotation has already happened at WorkOS. Preserve the new credential
      // even if JWKS retrieval or snapshot persistence subsequently fails.
      const rotated = await sealData(tokens, {
        password: config.password,
        ttl: 0,
      })
      const rotatedAt = clock()
      const saved = await env.DB.prepare(
        `UPDATE workos_billing_sessions SET encrypted_tokens = ?, updated_at = ?
        WHERE user_id = ? AND operation_token = ? AND reauth_needed = 0 AND lease_until > ?`
      )
        .bind(rotated, rotatedAt, userId, token, rotatedAt)
        .run()
      if (saved.meta.changes !== 1)
        throw new WorkOSEntitlementUnavailableError(
          "Billing access lease expired."
        )
      claims = await verify(tokens.accessToken, config.clientId, clock())
    }
    const value = proof(claims, tokens, config.entitlement)
    if (value.expiresAt <= clock())
      throw new WorkOSEntitlementUnavailableError(
        "Billing access proof expired."
      )
    const encrypted = await sealData(tokens, {
      password: config.password,
      ttl: 0,
    })
    const commitAt = clock()
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE workos_billing_sessions SET encrypted_tokens = ?, updated_at = ?
        WHERE user_id = ? AND operation_token = ? AND reauth_needed = 0 AND lease_until > ?`
      ).bind(encrypted, commitAt, userId, token, commitAt),
      snapshotStatement(
        env.DB,
        value,
        config.context,
        "EXISTS (SELECT 1 FROM workos_billing_sessions WHERE user_id = ? AND operation_token = ? AND reauth_needed = 0 AND lease_until > ?)",
        [userId, token, commitAt]
      ),
    ])
    if (result[0].meta.changes !== 1)
      throw new WorkOSEntitlementUnavailableError(
        "Billing access lease expired."
      )
    return snapshot((await readSnapshot(env.DB, userId))!)
  } catch (error) {
    if (
      error instanceof InvalidBillingCredentialsError ||
      terminalTokenFailure(error)
    ) {
      await requireReauthorization(env.DB, userId, token, clock())
      return null
    }
    throw error
  } finally {
    await env.DB.prepare(
      "UPDATE workos_billing_sessions SET operation_token = NULL, lease_until = 0 WHERE user_id = ? AND operation_token = ?"
    )
      .bind(userId, token)
      .run()
  }
}
