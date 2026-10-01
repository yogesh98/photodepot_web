import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { saveWaitlistEntry } from "../lib/waitlist.ts"
import { validateWaitlistEntry } from "../lib/waitlist-validation.ts"

const valid = {
  firstName: "Alex",
  lastName: "",
  email: "alex@example.com",
  heardAboutUs: "A friend",
}

test("required fields reject missing, blank, malformed and non-string values", () => {
  for (const value of [null, [], "hello", {}]) {
    assert.equal(validateWaitlistEntry(value).ok, false)
  }
  for (const field of ["firstName", "email", "heardAboutUs"]) {
    for (const value of [undefined, "", "   ", 123, {}]) {
      assert.equal(
        validateWaitlistEntry({ ...valid, [field]: value }).ok,
        false
      )
    }
  }
  for (const email of [
    "no-at-sign",
    "alex@",
    "@example.com",
    "alex @example.com",
  ]) {
    assert.equal(validateWaitlistEntry({ ...valid, email }).ok, false)
  }
  assert.equal(validateWaitlistEntry({ ...valid, lastName: 123 }).ok, false)
})

test("last name is optional and answers are trimmed, with normalized email", () => {
  const withoutLastName = { ...valid }
  delete withoutLastName.lastName
  assert.deepEqual(validateWaitlistEntry(withoutLastName), {
    ok: true,
    entry: valid,
  })
  assert.deepEqual(
    validateWaitlistEntry({
      firstName: "  Alex  ",
      lastName: "  O'Connor  ",
      email: "  ALEX@Example.com ",
      heardAboutUs: "  Instagram  ",
    }),
    {
      ok: true,
      entry: {
        firstName: "Alex",
        lastName: "O'Connor",
        email: "alex@example.com",
        heardAboutUs: "Instagram",
      },
    }
  )
})

test("field lengths are bounded before writing to disk", () => {
  for (const [field, length] of [
    ["firstName", 101],
    ["lastName", 101],
    ["email", 255],
    ["heardAboutUs", 501],
  ]) {
    assert.equal(
      validateWaitlistEntry({ ...valid, [field]: "x".repeat(length) }).ok,
      false
    )
  }
})

test("SQLite creates its directory, persists all answers and prevents duplicate emails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "photodepot-waitlist-"))
  const path = join(directory, "data", "waitlist.sqlite")
  try {
    const entry = {
      ...valid,
      firstName: "O'Connor",
      heardAboutUs: "Friend's post; DROP TABLE waitlist;",
    }
    saveWaitlistEntry(entry, path)
    saveWaitlistEntry({ ...entry, firstName: "Changed" }, path)
    saveWaitlistEntry(
      { ...valid, email: "second@example.com", lastName: "Patel" },
      path
    )

    // Reopen a separate connection to verify disk persistence, not in-memory state.
    const database = new DatabaseSync(path)
    try {
      const rows = database.prepare("SELECT * FROM waitlist ORDER BY id").all()
      assert.equal(rows.length, 2)
      assert.equal(rows[0].first_name, "O'Connor")
      assert.equal(rows[0].last_name, null)
      assert.equal(rows[0].email, "alex@example.com")
      assert.equal(rows[0].heard_about_us, entry.heardAboutUs)
      assert.match(rows[0].created_at, /^\d{4}-\d{2}-\d{2}T.+Z$/)
      assert.equal(rows[1].last_name, "Patel")
    } finally {
      database.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("storage failures propagate instead of reporting a successful signup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "photodepot-waitlist-error-"))
  try {
    assert.throws(() => saveWaitlistEntry(valid, directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
