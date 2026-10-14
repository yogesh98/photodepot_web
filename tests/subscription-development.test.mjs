import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEnv } from "node:util"
import { after, test } from "node:test"
import {
  setupDevelopment,
  prepareDevelopment,
  validateDevelopmentSettings,
} from "../scripts/subscription-development.mjs"
import { subscriptionEnvironment } from "../lib/subscription-environment.ts"

const temporary = []
after(async () => {
  await Promise.all(
    temporary.map((path) => rm(path, { recursive: true, force: true }))
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "photodepot-subscription-dev-"))
  temporary.push(root)
  const desktop = join(root, "desktop")
  await mkdir(desktop)
  return { root, desktop }
}
test("setup creates matched private server and public desktop keys, separate local persistence and repeatable files", async () => {
  const { root, desktop } = await fixture()
  const setup = await setupDevelopment(root, desktop)
  const secrets = await readFile(setup.secretsPath, "utf8")
  const desktopSettings = parseEnv(await readFile(setup.desktopPath, "utf8"))
  assert.equal(desktopSettings.PHOTODEPOT_ENVIRONMENT, "development")
  assert.equal(
    desktopSettings.PHOTODEPOT_LICENSE_API_URL,
    "http://localhost:8788"
  )
  assert.equal(desktopSettings.PHOTODEPOT_LICENSE_PUBLIC_KEY, setup.publicKey)
  assert.equal(
    "PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY" in desktopSettings,
    false
  )
  assert.equal((await stat(setup.secretsPath)).mode & 0o777, 0o600)
  await setupDevelopment(root, desktop)
  assert.equal(await readFile(setup.secretsPath, "utf8"), secrets)
  await writeFile(join(root, ".dev.vars"), "WORKOS_API_KEY=production-secret\n")
  const { runtime, persist } = await prepareDevelopment(root, false)
  assert.ok(persist.startsWith(runtime))
  const config = JSON.parse(
    await readFile(join(runtime, "wrangler.jsonc"), "utf8")
  )
  assert.equal(
    JSON.parse(await readFile(join(runtime, "package.json"), "utf8")).name,
    "photodepot-subscriptions-local"
  )
  assert.equal(
    config.d1_databases[0].database_name,
    "photodepot-subscriptions-local"
  )
  assert.equal(config.vars.PHOTODEPOT_ENVIRONMENT, "development")
  assert.equal(
    parseEnv(await readFile(join(runtime, ".dev.vars"), "utf8")).WORKOS_API_KEY,
    ""
  )
  await assert.rejects(prepareDevelopment(root), /WorkOS development/)
})
test("setup preserves a conflicting desktop authority and refuses silent switching", async () => {
  const { root, desktop } = await fixture()
  const original =
    "PHOTODEPOT_LICENSE_API_URL=https://photodepot.app\nPHOTODEPOT_LICENSE_PUBLIC_KEY=production\n"
  await writeFile(join(desktop, ".env.development"), original)
  await assert.rejects(setupDevelopment(root, desktop), /different authority/)
  assert.equal(
    await readFile(join(desktop, ".env.development"), "utf8"),
    original
  )
})
test("development startup rejects production API credentials, wrong callback, and missing settings", () => {
  const settings = {
    PHOTODEPOT_ENVIRONMENT: "development",
    WORKOS_REDIRECT_URI: "http://localhost:8788/api/auth/callback",
    PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY: "fixture",
    WORKOS_COOKIE_PASSWORD: "a".repeat(40),
    WORKOS_CLIENT_ID: "client_dev",
    WORKOS_ADMIN_ORGANIZATION_ID: "org_dev",
    WORKOS_API_KEY: "sk_test_fixture",
  }
  assert.doesNotThrow(() => validateDevelopmentSettings(settings))
  for (const changes of [
    { WORKOS_API_KEY: "sk_live_secret" },
    { WORKOS_CLIENT_ID: "" },
    { WORKOS_ADMIN_ORGANIZATION_ID: "" },
    { PHOTODEPOT_ENVIRONMENT: "production" },
    { WORKOS_REDIRECT_URI: "https://photodepot.app/api/auth/callback" },
  ])
    assert.throws(() =>
      validateDevelopmentSettings({ ...settings, ...changes })
    )
  assert.equal(subscriptionEnvironment({}), "production")
  assert.equal(
    subscriptionEnvironment({ PHOTODEPOT_ENVIRONMENT: "development" }),
    "development"
  )
  assert.throws(() =>
    subscriptionEnvironment({ PHOTODEPOT_ENVIRONMENT: "staging" })
  )
})
