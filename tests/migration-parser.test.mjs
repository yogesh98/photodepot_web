import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { unstable_splitSqlQuery } from "wrangler"

function assertRemoteTriggerSyntax(statement) {
  // Remote /query uses a different splitter from local Wrangler/Miniflare.
  // A read-only production EXPLAIN probe confirmed bare CASE END is rejected,
  // while the same expression in parentheses compiles without database changes.
  const tokens = statement.replace(
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/g,
    " "
  )
  assert.match(tokens, /\bBEGIN\b/, "Remote trigger BEGIN must be uppercase")
  let depth = 0
  let bareEnds = 0
  for (const match of tokens.matchAll(/\(|\)|\bEND\b/gi)) {
    if (match[0] === "(") depth++
    else if (match[0] === ")") depth--
    else if (depth === 0) bareEnds++
  }
  assert.equal(bareEnds, 1, "Parenthesize CASE END inside remote D1 triggers")
}

test("migration triggers retain remote D1 parser compatibility", async () => {
  const directory = new URL("../migrations/", import.meta.url)
  let triggerCount = 0
  for (const filename of (await readdir(directory)).filter((name) =>
    name.endsWith(".sql")
  )) {
    const source = await readFile(new URL(filename, directory), "utf8")
    assert.equal(
      source.includes("\r"),
      false,
      `${filename} must use LF line endings`
    )
    for (const statement of unstable_splitSqlQuery(source)) {
      if (!/\bCREATE\s+TRIGGER\b/i.test(statement)) continue
      triggerCount++
      assertRemoteTriggerSyntax(statement)
    }
  }
  assert.equal(triggerCount, 5)
})

test("remote parser regression rejects the locally valid bare CASE terminator", () => {
  assert.throws(
    () =>
      assertRemoteTriggerSyntax(
        "CREATE TRIGGER probe AFTER INSERT ON waitlist BEGIN SELECT CASE WHEN 1 THEN 1 END; END;"
      ),
    /Parenthesize CASE END/
  )
  assertRemoteTriggerSyntax(
    "CREATE TRIGGER probe AFTER INSERT ON waitlist BEGIN SELECT (CASE WHEN 1 THEN 1 END); END;"
  )
})

test("complete migration queries execute with the appended Wrangler migration journal", async () => {
  const database = new DatabaseSync(":memory:")
  const directory = new URL("../migrations/", import.meta.url)
  const filenames = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort()
  try {
    database.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations (name TEXT NOT NULL UNIQUE)"
    )
    for (const filename of filenames) {
      const source = await readFile(new URL(filename, directory), "utf8")
      // Match remote Wrangler's whole-query transport, rather than splitting
      // first as the Miniflare integration tests do.
      database.exec(
        `${source}\nINSERT INTO "d1_migrations" (name) values ('${filename}');`
      )
    }
    assert.deepEqual(
      database
        .prepare("SELECT name FROM d1_migrations ORDER BY name")
        .all()
        .map((row) => row.name),
      filenames
    )
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='trigger'"
        )
        .get().count,
      5
    )
    const deviceColumns = database
      .prepare("PRAGMA table_info(account_devices)")
      .all()
      .map((row) => row.name)
    assert.ok(deviceColumns.includes("active"))
    assert.ok(deviceColumns.includes("assignment_revision"))
  } finally {
    database.close()
  }
})
