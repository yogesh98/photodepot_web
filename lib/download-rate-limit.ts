import { createHmac } from "node:crypto"
import type { D1Database } from "@cloudflare/workers-types"

export async function allowPasswordAttempt(
  database: D1Database,
  ip: string,
  password: string,
  now = Date.now()
) {
  const key = createHmac("sha256", password)
    .update(`download-ip:${ip}`)
    .digest("hex")
  // Transactional batches share counters across isolates. Cleanup is bounded
  // and indexed, and raw client IP addresses never enter the database.
  const results = await database.batch<{ attempts: number }>([
    database
      .prepare(
        `DELETE FROM download_attempts WHERE key IN (
      SELECT key FROM download_attempts WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
    )`
      )
      .bind(now),
    database
      .prepare(
        `
      INSERT INTO download_attempts (key, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
        expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END
      WHERE expires_at <= ? OR attempts < 9
      RETURNING attempts
    `
      )
      .bind(key, now + 600_000, now, now, now + 600_000, now),
  ])
  const count = results[1].results[0]?.attempts
  return count !== undefined && count <= 8
}
