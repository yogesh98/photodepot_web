import type { D1Database } from "@cloudflare/workers-types"
import type { WaitlistEntry } from "./waitlist-validation.ts"

export async function saveWaitlistEntry(
  entry: WaitlistEntry,
  database: D1Database
) {
  await database
    .prepare(
      `
    INSERT INTO waitlist (first_name, last_name, email, heard_about_us)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO NOTHING
  `
    )
    .bind(
      entry.firstName,
      entry.lastName || null,
      entry.email,
      entry.heardAboutUs
    )
    .run()
}
