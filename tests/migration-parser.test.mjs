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
  assert.equal(triggerCount, 9)
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
      2
    )
    const deviceColumns = database
      .prepare("PRAGMA table_info(account_devices)")
      .all()
      .map((row) => row.name)
    assert.ok(deviceColumns.includes("active"))
    assert.ok(deviceColumns.includes("assignment_revision"))
    const sessionColumns = database
      .prepare("PRAGMA table_info(desktop_sessions)")
      .all()
      .map((row) => row.name)
    for (const field of [
      "id",
      "device_id",
      "user_id",
      "public_key",
      "active",
      "revision",
    ])
      assert.ok(sessionColumns.includes(field))
  } finally {
    database.close()
  }
})

test("device metadata migration retires foreign legacy shadows and preserves current session metadata as unknown", async () => {
  const database = new DatabaseSync(":memory:")
  const directory = new URL("../migrations/", import.meta.url)
  try {
    for (const name of (await readdir(directory))
      .filter((value) => value.endsWith(".sql"))
      .sort()) {
      if (name === "0012_desktop_device_metadata.sql") {
        database.exec(`INSERT INTO subscriptions (id,user_id,type,status,started_at,end_at,updated_at,revision) VALUES ('old-sub','user_old','regular','active',1,9999999999999,1,1);
          INSERT INTO account_devices (device_id,user_id,public_key,binding_revision,activated_at,active,assignment_revision) VALUES ('device','user_old','key',1,1,1,1);
          INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,created_at,updated_at) VALUES ('new-session','device','user_new','new@example.test','key',2,2);`)
      }
      database.exec(await readFile(new URL(name, directory), "utf8"))
    }
    assert.equal(
      database
        .prepare(
          "SELECT active FROM account_devices WHERE device_id = 'device'"
        )
        .get().active,
      0
    )
    assert.equal(
      database
        .prepare(
          "SELECT revision FROM subscriptions WHERE user_id = 'user_old'"
        )
        .get().revision,
      2
    )
    const session = database
      .prepare(
        "SELECT active,device_name,last_used_at FROM desktop_sessions WHERE id = 'new-session'"
      )
      .get()
    assert.equal(session.active, 1)
    assert.equal(session.device_name, null)
    assert.equal(session.last_used_at, null)
  } finally {
    database.close()
  }
})

test("manual cleanup preserves grant and audit history, carries renewal opt-outs to reminder preferences and removes legacy authority bridges", async () => {
  const database = new DatabaseSync(":memory:")
  const directory = new URL("../migrations/", import.meta.url)
  try {
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      if (name === "0013_manual_access_cleanup.sql") {
        database.exec(`INSERT INTO subscriptions(id,user_id,type,status,started_at,end_at,updated_at,revision,notes,canceled_at) VALUES('grant','user_migrated','trial','active',10,1000,20,3,'Existing note',15);
          INSERT INTO subscription_audit(id,subscription_id,action,actor,created_at,detail,reason) VALUES('audit','grant','cancel-renewal','owner',15,'Existing preference','Reason');
          INSERT INTO account_pairings(token_hash,code_hash,device_id,public_key,challenge,created_at,expires_at) VALUES('token','code','device','key','challenge',1,1000);`)
      }
      database.exec(await readFile(new URL(name, directory), "utf8"))
    }
    const grant = database
      .prepare("SELECT * FROM subscriptions WHERE id=?")
      .get("grant")
    assert.equal(grant.reminder_opt_out_at, 15)
    assert.equal(grant.canceled_at, 15)
    assert.equal(grant.revision, 3)
    assert.equal(grant.started_at, 10)
    assert.equal(grant.end_at, 1000)
    assert.equal(grant.notes, "Existing note")
    assert.equal(
      database.prepare("SELECT action,reason FROM subscription_audit").get()
        .action,
      "cancel-renewal"
    )
    assert.equal(
      database.prepare("SELECT status FROM account_pairings").get().status,
      "cancelled"
    )
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='trigger' ORDER BY name"
        )
        .all()
        .map((row) => row.name),
      ["desktop_sessions_two_slot_insert", "desktop_sessions_two_slot_update"]
    )
  } finally {
    database.close()
  }
})
