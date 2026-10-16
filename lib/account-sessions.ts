import { randomUUID, sign } from "node:crypto"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { BodyError, json, readJson, type Env } from "./cloudflare.ts"
import {
  CHALLENGE_PATTERN,
  LICENSE_GRACE_MS,
  parseDevicePublicKey,
  signedReceipt,
  signingKey,
  validDeviceProof,
} from "./license-crypto.ts"
import { allowLicenseAttempt } from "./license-rate-limit.ts"
import { subscriptionReason } from "./subscription-store.ts"
import { getAccountEntitlement } from "./account-entitlement.ts"
import type {
  AccountDevice,
  AccountDeviceHistory,
} from "./subscription-types.ts"
import { getWorkOSUser, WORKOS_USER_ID } from "./workos-users.ts"
import { validDeviceName } from "./account-device-metadata.ts"

export interface DesktopSession {
  id: string
  device_id: string
  user_id: string
  email: string
  public_key: string
  active: number
  revision: number
  created_at: number
  updated_at: number
  device_name: string | null
  last_used_at: number | null
}
const sessionPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export function getDesktopSession(database: D1Database, id: string) {
  return database
    .prepare("SELECT * FROM desktop_sessions WHERE id = ?")
    .bind(id)
    .first<DesktopSession>()
}
/** Keep directory lookups below D1's bound-parameter limit, including filtered scans. */
export async function listAccountDevicesForUsers(
  database: D1Database,
  userIds: string[]
): Promise<Map<string, AccountDevice[]>> {
  const uniqueIds = [...new Set(userIds)]
  if (
    uniqueIds.some(
      (userId) => typeof userId !== "string" || !WORKOS_USER_ID.test(userId)
    )
  )
    throw new TypeError("Invalid WorkOS user.")
  const devices = new Map<string, AccountDevice[]>(
    uniqueIds.map((userId) => [userId, []])
  )
  for (let offset = 0; offset < uniqueIds.length; offset += 90) {
    const batch = uniqueIds.slice(offset, offset + 90)
    const rows = await database
      .prepare(
        `SELECT user_id AS userId, device_id AS id, created_at AS activatedAt,
      id AS sessionId, revision, device_name AS deviceName, last_used_at AS lastUsedAt
      FROM desktop_sessions WHERE active = 1 AND user_id IN (${batch.map(() => "?").join(", ")})
      ORDER BY user_id, created_at, id`
      )
      .bind(...batch)
      .all<AccountDevice & { userId: string }>()
    for (const { userId, ...device } of rows.results)
      devices.get(userId)!.push(device)
  }
  return devices
}

export async function listAccountDevices(
  database: D1Database,
  userId: string
): Promise<AccountDevice[]> {
  return (await listAccountDevicesForUsers(database, [userId])).get(userId)!
}

export async function listAccountDeviceHistory(
  database: D1Database,
  userId: string
): Promise<AccountDeviceHistory[]> {
  const rows = await database
    .prepare(
      `SELECT device_id AS id, created_at AS activatedAt,
    id AS sessionId, revision, device_name AS deviceName, last_used_at AS lastUsedAt, active AS current
    FROM desktop_sessions WHERE user_id = ? ORDER BY created_at DESC, id DESC`
    )
    .bind(userId)
    .all<AccountDevice & { current: number }>()
  return rows.results.map((row) => ({ ...row, current: row.current === 1 }))
}

/** A browser approval creates its session atomically; polling can only deliver it. */
export async function approveDesktopSession(
  database: D1Database,
  codeHash: string,
  userId: string,
  email: string,
  now = Date.now(),
  replacement?: { deviceId: string; sessionId: string; revision: number }
) {
  const id = randomUUID()
  // The inert binding value satisfies the retained historical pairing CHECK.
  // Modern authorization depends exclusively on session_id and session revisions.
  const results = await database.batch([
    database
      .prepare(
        `UPDATE account_pairings SET status = 'approved', user_id = ?, approved_binding_revision = 1, session_id = ?
      WHERE code_hash = ? AND account_version = 1 AND status = 'pending'
      AND expires_at > MAX(?, CAST(unixepoch('subsec') * 1000 AS INTEGER))
      ${
        replacement
          ? `AND device_id != ? AND EXISTS (SELECT 1 FROM desktop_sessions selected
        WHERE selected.id = ? AND selected.device_id = ? AND selected.user_id = ? AND selected.active = 1 AND selected.revision = ?)`
          : ""
      }
      AND (SELECT COUNT(*) FROM desktop_sessions used WHERE used.user_id = ? AND used.active = 1
        AND used.device_id != account_pairings.device_id ${replacement ? "AND used.device_id != ?" : ""}) < 2 RETURNING token_hash`
      )
      .bind(
        userId,
        id,
        codeHash,
        now,
        ...(replacement
          ? [
              replacement.deviceId,
              replacement.sessionId,
              replacement.deviceId,
              userId,
              replacement.revision,
            ]
          : []),
        userId,
        ...(replacement ? [replacement.deviceId] : [])
      ),
    ...(replacement
      ? desktopRevocationStatements(
          database,
          replacement.sessionId,
          userId,
          replacement.revision,
          now,
          id
        )
      : []),
    database
      .prepare(
        `UPDATE desktop_sessions SET active = 0, revision = revision + 1, updated_at = ?
      WHERE active = 1 AND device_id = (SELECT device_id FROM account_pairings WHERE session_id = ? AND status = 'approved')`
      )
      .bind(now, id),
    database
      .prepare(
        `INSERT INTO desktop_sessions (id, device_id, user_id, email, public_key, created_at, updated_at, device_name, last_used_at)
      SELECT session_id, device_id, user_id, ?, public_key, ?, ?, device_name, ? FROM account_pairings WHERE session_id = ? AND status = 'approved'`
      )
      .bind(email, now, now, now, id),
  ])
  return results[0].results.length === 1
}

/** Logout and console removal share this revocation transaction. */
export async function revokeDesktopSession(
  database: D1Database,
  id: string,
  userId: string,
  expectedRevision?: number,
  now = Date.now()
) {
  const results = await database.batch(
    desktopRevocationStatements(database, id, userId, expectedRevision, now)
  )
  return results[0].results[0] as unknown as DesktopSession | undefined
}

export class AccountDeviceConflictError extends Error {
  constructor() {
    super("This computer changed. Refresh and try again.")
  }
}

export async function removeAccountDevice(
  database: D1Database,
  userId: string,
  sessionId: string,
  expectedRevision: number,
  actor: string,
  now = Date.now(),
  reason?: string
) {
  if (
    !/^user_[A-Za-z0-9_]{1,120}$/.test(userId) ||
    !sessionPattern.test(sessionId) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    typeof actor !== "string" ||
    !actor.trim() ||
    actor.length > 320
  )
    throw new TypeError("Choose a current computer.")
  const normalizedReason = subscriptionReason(reason)
  const revocationId = randomUUID()
  const results = await database.batch([
    database
      .prepare(
        `UPDATE desktop_sessions SET active = 0, revision = revision + 1, updated_at = ?, revocation_id = ?
      WHERE id = ? AND user_id = ? AND active = 1 AND revision = ? RETURNING id`
      )
      .bind(now, revocationId, sessionId, userId, expectedRevision),
    database
      .prepare(
        `INSERT INTO account_device_audit (id,user_id,session_id,action,actor,created_at,reason)
      SELECT ?,user_id,id,'remove-device',?,?,? FROM desktop_sessions WHERE id = ? AND revocation_id = ? AND changes() = 1`
      )
      .bind(
        randomUUID(),
        actor,
        now,
        normalizedReason,
        sessionId,
        revocationId
      ),
    ...desktopRevocationCleanup(database, revocationId, now, { sessionId }),
  ])
  if (!results[0].results.length) throw new AccountDeviceConflictError()
  return listAccountDevices(database, userId)
}

/** Read the pairing's current session inside the same transaction as cancellation. */
export async function cancelAccountPairing(
  database: D1Database,
  tokenHash: string,
  now = Date.now()
) {
  const revocationId = randomUUID()
  await database.batch([
    database
      .prepare(
        "UPDATE account_pairings SET status = 'cancelled' WHERE token_hash = ?"
      )
      .bind(tokenHash),
    database
      .prepare(
        `UPDATE desktop_sessions SET active = 0, revision = revision + 1, updated_at = ?, revocation_id = ?
      WHERE active = 1 AND id IN (SELECT session_id FROM account_pairings WHERE token_hash = ? AND account_version = 1)`
      )
      .bind(now, revocationId, tokenHash),
    ...desktopRevocationCleanup(database, revocationId, now, {
      pairingTokenHash: tokenHash,
    }),
  ])
}

/** Shared by logout, console removal, and atomic sign-in slot replacement. */
function desktopRevocationStatements(
  database: D1Database,
  id: string,
  userId: string,
  expectedRevision: number | undefined,
  now: number,
  approvedSessionId?: string
): D1PreparedStatement[] {
  const revocationId = randomUUID()
  return [
    database
      .prepare(
        `UPDATE desktop_sessions SET active = 0, revision = revision + 1, updated_at = ?, revocation_id = ?
      WHERE id = ? AND user_id = ? AND active = 1 AND (? IS NULL OR revision = ?)
      ${approvedSessionId ? "AND EXISTS (SELECT 1 FROM account_pairings WHERE session_id = ? AND status = 'approved')" : ""} RETURNING *`
      )
      .bind(
        now,
        revocationId,
        id,
        userId,
        expectedRevision ?? null,
        expectedRevision ?? null,
        ...(approvedSessionId ? [approvedSessionId] : [])
      ),
    ...desktopRevocationCleanup(database, revocationId, now, { sessionId: id }),
  ]
}

function desktopRevocationCleanup(
  database: D1Database,
  revocationId: string,
  now: number,
  source: { sessionId: string } | { pairingTokenHash: string }
): D1PreparedStatement[] {
  const sessionId =
    "sessionId" in source
      ? "?"
      : "(SELECT session_id FROM account_pairings WHERE token_hash = ?)"
  const sourceValue =
    "sessionId" in source ? source.sessionId : source.pairingTokenHash
  return [
    database
      .prepare(
        `UPDATE account_pairings SET status = 'cancelled' WHERE (device_id, user_id) IN
      (SELECT device_id, user_id FROM desktop_sessions WHERE id = ${sessionId} AND revocation_id = ?)`
      )
      .bind(sourceValue, revocationId),
  ]
}

export async function desktopSessionResponse(
  env: Env,
  row: DesktopSession,
  challenge: string,
  now = Date.now()
) {
  const entitlement =
    row.active === 1 ? await getAccountEntitlement(env, row.user_id, now) : null
  const subscription = entitlement?.grant ?? null
  // A removal can race the subscription read; sign only the latest session.
  row = (await getDesktopSession(env.DB, row.id))!
  const signer = signingKey(env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY)
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      sessionId: row.id,
      deviceId: row.device_id,
      userId: row.user_id,
      email: row.email,
      status: row.active === 1 ? "active" : "revoked",
      revision: row.revision,
      challenge,
      issuedAt: now,
      expiresAt: now + LICENSE_GRACE_MS,
    })
  ).toString("base64url")
  const session = {
    payload,
    signature: sign(null, Buffer.from(payload, "base64url"), signer).toString(
      "base64url"
    ),
  }
  const receipt =
    row.active === 1 && subscription !== null && entitlement?.access.canHost
      ? signedReceipt(
          signer,
          {
            licenseId: subscription.id,
            deviceId: row.device_id,
            type: subscription.type,
            status: "active",
            challenge,
            revision: subscription.revision,
            subscriptionEndsAt: subscription.endsAt,
          },
          now,
          subscription.endsAt
        )
      : undefined
  return { session, ...(receipt ? { receipt } : {}) }
}

export async function handleDesktopSession(
  request: Request,
  env: Env,
  action: "verify" | "logout"
) {
  if (request.method !== "POST") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "POST")
    return response
  }
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Submit JSON." }, 415)
  try {
    const body = (await readJson(request)) as Record<string, unknown> | null
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.sessionId !== "string" ||
      !sessionPattern.test(body.sessionId) ||
      typeof body.deviceId !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.deviceId) ||
      typeof body.challenge !== "string" ||
      !CHALLENGE_PATTERN.test(body.challenge)
    )
      return json({ error: "Invalid Mac session request." }, 400)
    if (body.deviceName !== undefined && !validDeviceName(body.deviceName))
      return json({ error: "Invalid computer name." }, 400)
    const allowed = await allowLicenseAttempt(
      env.DB,
      `account-session-${action}`,
      request.headers.get("cf-connecting-ip") ?? "unknown",
      env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY!,
      120,
      60_000
    )
    if (!allowed)
      return json({ error: "Too many requests. Try again shortly." }, 429)
    let row = await getDesktopSession(env.DB, body.sessionId)
    if (!row) return json({ error: "Sign in to Photodepot to continue." }, 404)
    const device = parseDevicePublicKey(row.public_key)
    if (
      row.device_id !== body.deviceId ||
      device.deviceId !== body.deviceId ||
      !validDeviceProof(device.key, body.deviceSignature, [
        "photodepot-account-session-v1",
        action,
        body.sessionId,
        body.deviceId,
        body.challenge,
        ...(body.deviceName === undefined ? [] : [body.deviceName as string]),
      ])
    )
      return json({ error: "Mac verification failed." }, 401)
    if (action === "logout") {
      await revokeDesktopSession(env.DB, row.id, row.user_id)
    } else if (row.active === 1) {
      let user = null
      let lookupError: unknown
      try {
        user = await getWorkOSUser(env, row.user_id)
      } catch (error) {
        lookupError = error
      }
      row = (await getDesktopSession(env.DB, row.id))!
      if (lookupError && row.active === 1) throw lookupError
      if (row.active === 1 && !user?.emailVerified)
        await revokeDesktopSession(env.DB, row.id, row.user_id)
    }
    row = (await getDesktopSession(env.DB, row.id))!
    if (row.active === 1 && action === "verify")
      await env.DB.prepare(
        "UPDATE desktop_sessions SET last_used_at = ?, device_name = COALESCE(?, device_name) WHERE id = ? AND active = 1"
      )
        .bind(Date.now(), body.deviceName ?? null, row.id)
        .run()
    return json(await desktopSessionResponse(env, row, body.challenge))
  } catch (error) {
    if (error instanceof BodyError)
      return json({ error: "Invalid request." }, error.status)
    console.error("Account session service unavailable")
    return json(
      {
        error:
          "Account verification is temporarily unavailable. Please try again.",
      },
      503
    )
  }
}
