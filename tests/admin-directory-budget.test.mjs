import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, test } from "node:test"
import { listAdminUsers } from "../lib/admin-directory.ts"

const now = 1_800_000_000_000
const clientId = "client_directory_budget"
let sqlite, env, originalFetch, providerUsers, providerPageSize, metrics

function user(index) {
  return {
    object: "user",
    id: `user_budget_${String(index).padStart(4, "0")}`,
    email: `person${index}@example.test`,
    email_verified: true,
    first_name: "Test",
    last_name: "Customer",
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  }
}
function database() {
  const networkCall = () => {
    metrics.d1Calls++
    assert.ok(metrics.d1Calls <= 1000, "Free plan D1 request budget exceeded")
  }
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql)
      let values = []
      const execute = () => {
        metrics.queries++
        return {
          results: statement.all(...values),
          meta: { changes: sqlite.prepare("SELECT changes() AS n").get().n },
        }
      }
      return {
        bind(...bound) {
          values = bound
          return this
        },
        async first() {
          networkCall()
          if (sql.includes("SELECT * FROM workos_billing_sessions"))
            metrics.hydratedIds.push(values[0])
          return execute().results[0] ?? null
        },
        async all() {
          networkCall()
          return execute()
        },
        async run() {
          networkCall()
          return execute()
        },
        execute,
      }
    },
    async batch(statements) {
      networkCall()
      sqlite.exec("BEGIN")
      try {
        const result = statements.map((statement) => statement.execute())
        sqlite.exec("COMMIT")
        return result
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  }
}
function resetMetrics() {
  metrics = { d1Calls: 0, queries: 0, providerCalls: 0, hydratedIds: [] }
}
async function page(query = "") {
  resetMetrics()
  const result = await listAdminUsers(env, new URLSearchParams(query), now)
  assert.ok(metrics.d1Calls < 1000)
  assert.ok(metrics.providerCalls < 50)
  assert.ok(metrics.hydratedIds.length <= 20)
  return result
}
function managed(userId, enabled, reauthNeeded = 0) {
  sqlite
    .prepare(
      "INSERT INTO stripe_customers(user_id,stripe_customer_id,workos_organization_id,customer_create_token) VALUES(?,?,?,?)"
    )
    .run(userId, `cus_${userId}`, `org_${userId}`, `token_${userId}`)
  sqlite
    .prepare(
      "INSERT INTO workos_billing_sessions(user_id,session_id,encrypted_tokens,reauth_needed,updated_at) VALUES(?,?,?,?,?)"
    )
    .run(
      userId,
      `session_${userId}`,
      "not-used-for-current-proof",
      reauthNeeded,
      now
    )
  sqlite
    .prepare(
      "INSERT INTO workos_entitlements(user_id,organization_id,context,enabled,issued_at,expires_at,revision) VALUES(?,?,?,?,?,?,1)"
    )
    .run(
      userId,
      `org_${userId}`,
      JSON.stringify([clientId, "photodepot-standard"]),
      enabled ? 1 : 0,
      now,
      now + 300_000
    )
}
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:")
  const migrations = new URL("../migrations/", import.meta.url)
  for (const filename of (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(await readFile(new URL(filename, migrations), "utf8"))
  resetMetrics()
  providerUsers = Array.from({ length: 1000 }, (_, index) => user(index))
  providerPageSize = 100
  env = {
    DB: database(),
    WORKOS_CLIENT_ID: clientId,
    WORKOS_API_KEY: "sk_directory_fixture",
    WORKOS_COOKIE_PASSWORD: "directory-budget-test-cookie-password-at-least-32",
  }
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(url.origin, "https://api.workos.com")
    assert.equal(url.pathname, "/user_management/users")
    assert.equal(url.searchParams.get("limit"), "100")
    metrics.providerCalls++
    const after = url.searchParams.get("after")
    const start = after
      ? providerUsers.findIndex((entry) => entry.id === after) + 1
      : 0
    const data = providerUsers.slice(start, start + providerPageSize)
    return Response.json({
      object: "list",
      data,
      list_metadata: {
        before: null,
        after:
          start + data.length < providerUsers.length ? data.at(-1).id : null,
      },
    })
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
  sqlite.close()
})

test("an unmatched 1000-account search stays within each invocation's request budget and advances", async () => {
  let cursor = null
  const seen = []
  do {
    const result = await page(
      new URLSearchParams({
        q: "missing-person",
        ...(cursor ? { cursor } : {}),
      })
    )
    assert.deepEqual(result.users, [])
    assert.ok(!result.nextCursor || result.nextCursor !== cursor)
    seen.push(...metrics.hydratedIds)
    cursor = result.nextCursor
  } while (cursor)
  assert.deepEqual(
    seen,
    providerUsers.map((entry) => entry.id)
  )
})

test("a truncated final provider page retains its cursor without skipping users or checking leftover accounts", async () => {
  providerUsers = providerUsers.slice(0, 45)
  let cursor = null
  const seen = []
  do {
    const result = await page(cursor ? `cursor=${cursor}` : "")
    const ids = result.users.map((entry) => entry.id)
    assert.deepEqual(metrics.hydratedIds, ids)
    seen.push(...ids)
    cursor = result.nextCursor
    if (seen.length === 20) assert.equal(cursor, providerUsers[19].id)
    if (seen.length === 40) assert.equal(cursor, providerUsers[39].id)
  } while (cursor)
  assert.deepEqual(
    seen,
    providerUsers.map((entry) => entry.id)
  )
})

test("filtered continuations reach paid accounts beyond empty match pages and reject unusable proof", async () => {
  providerUsers = providerUsers.slice(0, 45)
  managed(providerUsers[19].id, true, 1)
  managed(providerUsers[20].id, true)
  managed(providerUsers[40].id, true)
  managed(providerUsers[41].id, false)
  for (const filter of ["active", "standard", "unassigned"]) {
    let cursor = null
    const seen = []
    do {
      const result = await page(
        new URLSearchParams({ filter, ...(cursor ? { cursor } : {}) })
      )
      if (filter !== "unassigned" && seen.length === 0 && cursor === null) {
        assert.deepEqual(result.users, [])
        assert.equal(result.nextCursor, providerUsers[19].id)
      }
      seen.push(...result.users.map((entry) => entry.id))
      cursor = result.nextCursor
    } while (cursor)
    const paidIds = [providerUsers[20].id, providerUsers[40].id]
    assert.deepEqual(
      seen,
      filter === "unassigned"
        ? providerUsers
            .map((entry) => entry.id)
            .filter((id) => !paidIds.includes(id))
        : paidIds
    )
  }
})

test("small provider pages cannot bypass the hydration budget during filtered scans", async () => {
  providerPageSize = 3
  const result = await page("q=missing-person")
  assert.deepEqual(result.users, [])
  assert.equal(result.nextCursor, providerUsers[19].id)
  assert.deepEqual(
    metrics.hydratedIds,
    providerUsers.slice(0, 20).map((entry) => entry.id)
  )
  assert.equal(metrics.providerCalls, 7)
})
