import { createHmac } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"
export async function allowLicenseAttempt(
  database: D1Database,
  scope: string,
  identifier: string,
  secret: string,
  limit: number,
  windowMs: number,
  now = Date.now()
) {
  const key = createHmac("sha256", secret)
    .update(`${scope}:${identifier}`)
    .digest("hex")
  const result = await database.batch<{ attempts: number }>([
    database
      .prepare(
        "DELETE FROM license_attempts WHERE key IN (SELECT key FROM license_attempts WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)"
      )
      .bind(now),
    database
      .prepare(
        `INSERT INTO license_attempts (key, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END
      WHERE expires_at <= ? OR attempts < ? RETURNING attempts`
      )
      .bind(key, now + windowMs, now, now, now + windowMs, now, limit + 1),
  ])
  const attempts = result[1].results[0]?.attempts
  return attempts !== undefined && attempts <= limit
}
