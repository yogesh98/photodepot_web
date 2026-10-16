import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { before, after, test } from "node:test"
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler"
import {
  listAccountDevices,
  listAccountDevicesForUsers,
  listAccountDeviceHistory,
  removeAccountDevice,
  AccountDeviceConflictError,
} from "../lib/account-sessions.ts"
import { getSubscription, setSubscription } from "../lib/subscription-store.ts"
let platform, database
const now = Date.now()
before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  database = platform.env.DB
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await database.batch(
      unstable_splitSqlQuery(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8"
        )
      ).map((sql) => database.prepare(sql))
    )
})
after(async () => platform?.dispose())
async function device(userId) {
  const id = randomUUID()
  const fingerprint = randomUUID().replaceAll("-", "").repeat(2)
  await database
    .prepare(
      `INSERT INTO desktop_sessions (id,device_id,user_id,email,public_key,created_at,updated_at) VALUES (?,?,?,'private@example.test','private-key',?,?)`
    )
    .bind(id, fingerprint, userId, now, now)
    .run()
  return { id, deviceId: fingerprint }
}
test("Free accounts have the same two-computer capacity enforced by database transactions", async () => {
  const userId = "user_free_capacity"
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () => device(userId))
  )
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    2
  )
  const devices = await listAccountDevices(database, userId)
  assert.equal(devices.length, 2)
  assert.equal(await getSubscription(database, userId), null)
  assert.equal(JSON.stringify(devices).includes("private"), false)
})
test("removing a Free computer requires its own current revision, records an audit and preserves other computers", async () => {
  const userId = "user_free_removal"
  const first = await device(userId),
    second = await device(userId)
  await assert.rejects(
    removeAccountDevice(
      database,
      "user_other",
      first.id,
      1,
      "owner@example.test"
    ),
    AccountDeviceConflictError
  )
  await assert.rejects(
    removeAccountDevice(database, userId, first.id, 2, "owner@example.test"),
    AccountDeviceConflictError
  )
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      removeAccountDevice(
        database,
        userId,
        first.id,
        1,
        "owner@example.test",
        now,
        "Support case"
      )
    )
  )
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  )
  assert.deepEqual(
    (await listAccountDevices(database, userId)).map(
      (value) => value.sessionId
    ),
    [second.id]
  )
  const audit = await database
    .prepare("SELECT actor,reason FROM account_device_audit WHERE user_id=?")
    .bind(userId)
    .all()
  assert.deepEqual(audit.results, [
    { actor: "owner@example.test", reason: "Support case" },
  ])
  const history = await listAccountDeviceHistory(database, userId)
  assert.equal(
    history.find((value) => value.sessionId === first.id).current,
    false
  )
  assert.equal(
    history.find((value) => value.sessionId === second.id).current,
    true
  )
})
test("device changes do not advance grant revisions or influence access reads", async () => {
  const userId = "user_grant_device_isolation"
  const grant = await setSubscription(
    database,
    { userId, type: "trial", endsAt: now + 86400000, expectedRevision: 0 },
    "owner@example.test",
    now
  )
  const first = await device(userId)
  await removeAccountDevice(
    database,
    userId,
    first.id,
    1,
    "owner@example.test",
    now + 1
  )
  assert.deepEqual(await getSubscription(database, userId, now), grant)
  for (const key of ["devices", "bindingRevision", "assignmentRevision"])
    assert.equal(key in grant, false)
})
test("device audit failure rolls back revocation and cancelled approvals", async () => {
  const userId = "user_device_audit_failure"
  const first = await device(userId)
  await database
    .prepare(
      `CREATE TRIGGER reject_device_audit BEFORE INSERT ON account_device_audit BEGIN SELECT RAISE(ABORT,'device audit unavailable'); END`
    )
    .run()
  try {
    await assert.rejects(
      removeAccountDevice(database, userId, first.id, 1, "owner@example.test"),
      /device audit unavailable/
    )
    assert.equal((await listAccountDevices(database, userId)).length, 1)
  } finally {
    await database.prepare("DROP TRIGGER reject_device_audit").run()
  }
})
test("legacy binding records and epochs have no authority over modern sessions", async () => {
  const userId = "user_legacy_history"
  await setSubscription(
    database,
    { userId, type: "regular", endsAt: now + 86400000, expectedRevision: 0 },
    "owner@example.test",
    now
  )
  const first = await device(userId)
  await database
    .prepare(
      `INSERT INTO account_devices(device_id,user_id,public_key,binding_revision,activated_at,active) VALUES (?,?, 'legacy-key',1,?,1)`
    )
    .bind(first.deviceId, userId, now)
    .run()
  await database
    .prepare(
      "UPDATE subscriptions SET binding_revision=binding_revision+1 WHERE user_id=?"
    )
    .bind(userId)
    .run()
  await database
    .prepare("UPDATE account_devices SET active=0 WHERE user_id=?")
    .bind(userId)
    .run()
  assert.equal((await listAccountDevices(database, userId)).length, 1)
  assert.equal((await listAccountDeviceHistory(database, userId)).length, 1)
})

test("bulk device lookups deduplicate users and batch at most 90 IDs per query", async () => {
  const userIds = Array.from(
    { length: 205 },
    (_, index) => `user_bulk_devices_${index}`
  )
  const first = await device(userIds[0])
  await device(userIds[0])
  const revoked = await device(userIds[1])
  await removeAccountDevice(
    database,
    userIds[1],
    revoked.id,
    1,
    "owner@example.test"
  )
  const last = await device(userIds.at(-1))
  const parameters = []
  const queries = []
  const recordingDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql) => {
          queries.push(sql)
          const statement = target.prepare(sql)
          return {
            bind(...values) {
              parameters.push(values)
              return statement.bind(...values)
            },
          }
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  assert.deepEqual(
    await listAccountDevicesForUsers(recordingDatabase, []),
    new Map()
  )
  assert.equal(queries.length, 0)
  const grouped = await listAccountDevicesForUsers(recordingDatabase, [
    ...userIds,
    userIds[0],
    userIds.at(-1),
  ])
  assert.equal(queries.length, 3)
  assert.deepEqual(
    parameters.map((batch) => batch.length),
    [90, 90, 25]
  )
  assert.deepEqual(parameters.flat(), userIds)
  assert.equal(grouped.size, 205)
  assert.deepEqual(
    grouped.get(userIds[0]),
    await listAccountDevices(database, userIds[0])
  )
  assert.equal(
    grouped.get(userIds[0]).some((value) => value.sessionId === first.id),
    true
  )
  assert.deepEqual(grouped.get(userIds[1]), [])
  assert.deepEqual(
    grouped.get(userIds.at(-1)).map((value) => value.sessionId),
    [last.id]
  )
  assert.equal(
    JSON.stringify([...grouped.values()]).includes("private-key"),
    false
  )
  await assert.rejects(
    listAccountDevicesForUsers(recordingDatabase, ["invalid-user"]),
    TypeError
  )
  assert.equal(queries.length, 3)
})
