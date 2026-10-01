import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { WaitlistEntry } from "./waitlist-validation"

export function saveWaitlistEntry(
  entry: WaitlistEntry,
  path = process.env.PHOTODEPOT_WAITLIST_DB_PATH || "data/waitlist.sqlite"
) {
  const databasePath = resolve(path)
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS waitlist (
        id INTEGER PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT,
        email TEXT NOT NULL UNIQUE,
        heard_about_us TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
    `)
    database
      .prepare(
        `
        INSERT INTO waitlist (first_name, last_name, email, heard_about_us)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO NOTHING
      `
      )
      .run(
        entry.firstName,
        entry.lastName || null,
        entry.email,
        entry.heardAboutUs
      )
  } finally {
    database.close()
  }
}
