import { spawnSync } from "node:child_process"
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto"
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseEnv } from "node:util"

const repository = fileURLToPath(new URL("../", import.meta.url))
const secretsName = ".dev.vars.development"

async function writeNew(path, content) {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 })
    return true
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    return false
  }
}

export async function setupDevelopment(root, desktopDirectory) {
  const path = join(root, secretsName)
  const pair = generateKeyPairSync("ed25519")
  await writeNew(
    path,
    [
      "# Server-only localhost development secrets. Never copy production credentials here.",
      "PHOTODEPOT_ENVIRONMENT=development",
      `PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY=${pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`,
      `WORKOS_COOKIE_PASSWORD=${randomBytes(48).toString("base64url")}`,
      "WORKOS_REDIRECT_URI=http://localhost:8788/api/auth/callback",
      "WORKOS_CLIENT_ID=",
      "WORKOS_ADMIN_ORGANIZATION_ID=",
      "WORKOS_API_KEY=",
      "# Optional locally; signup callback also activates trials. Use a dev-only webhook secret.",
      "WORKOS_WEBHOOK_SECRET=",
      "",
    ].join("\n")
  )
  const settings = parseEnv(await readFile(path, "utf8"))
  validateDevelopmentSettings(settings, false)
  const privateKey = createPrivateKey({
    key: Buffer.from(settings.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY, "base64"),
    format: "der",
    type: "pkcs8",
  })
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("Development signing key must use Ed25519.")
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64url")
  const desktopPath = join(desktopDirectory, ".env.development")
  const desktopContent = `PHOTODEPOT_ENVIRONMENT=development\nPHOTODEPOT_LICENSE_API_URL=http://localhost:8788\nPHOTODEPOT_LICENSE_PUBLIC_KEY=${publicKey}\n`
  if (!(await writeNew(desktopPath, desktopContent))) {
    const existing = parseEnv(await readFile(desktopPath, "utf8"))
    if (
      existing.PHOTODEPOT_LICENSE_API_URL !== "http://localhost:8788" ||
      existing.PHOTODEPOT_LICENSE_PUBLIC_KEY !== publicKey
    )
      throw new Error(
        "Existing desktop .env.development uses a different authority. It was preserved; update it deliberately to match this server."
      )
  }
  return { secretsPath: path, desktopPath, publicKey }
}

export function validateDevelopmentSettings(settings, requireWorkOS = true) {
  if (
    settings.PHOTODEPOT_ENVIRONMENT !== "development" ||
    settings.WORKOS_REDIRECT_URI !== "http://localhost:8788/api/auth/callback"
  )
    throw new Error(
      "Local subscription development requires development settings and the localhost:8788 callback."
    )
  if (
    !settings.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY ||
    !settings.WORKOS_COOKIE_PASSWORD ||
    settings.WORKOS_COOKIE_PASSWORD.length < 32
  )
    throw new Error(
      "Run subscriptions:setup to generate local signing and cookie keys."
    )
  if (
    requireWorkOS &&
    (!/^client_[A-Za-z0-9_]+$/.test(settings.WORKOS_CLIENT_ID ?? "") ||
      !/^org_[A-Za-z0-9_]+$/.test(
        settings.WORKOS_ADMIN_ORGANIZATION_ID ?? ""
      ) ||
      !/^sk_test_/.test(settings.WORKOS_API_KEY ?? ""))
  )
    throw new Error(
      "Add the WorkOS development client ID, Owner organization ID, and sk_test_ API key to .dev.vars.development. Register http://localhost:8788/api/auth/callback in that WorkOS environment."
    )
}

export async function prepareDevelopment(root, requireWorkOS = true) {
  const settings = parseEnv(await readFile(join(root, secretsName), "utf8"))
  validateDevelopmentSettings(settings, requireWorkOS)
  const runtime = join(root, ".wrangler", "subscription-development")
  await mkdir(runtime, { recursive: true })
  // Pages locates generated worker scripts relative to the nearest package.
  // Give the isolated runtime its own root, otherwise it discovers this repo.
  await writeFile(
    join(runtime, "package.json"),
    '{"name":"photodepot-subscriptions-local","private":true,"type":"module"}\n'
  )
  // A dedicated Wrangler working directory prevents automatic loading of production .dev.vars.
  const config = {
    name: "photodepot-subscriptions-local",
    pages_build_output_dir: resolve(root, "out"),
    compatibility_date: "2026-10-08",
    compatibility_flags: ["nodejs_compat"],
    vars: { PHOTODEPOT_ENVIRONMENT: "development" },
    d1_databases: [
      {
        binding: "DB",
        database_name: "photodepot-subscriptions-local",
        database_id: "00000000-0000-0000-0000-000000000001",
        migrations_dir: resolve(root, "migrations"),
      },
    ],
    r2_buckets: [
      { binding: "DOWNLOADS", bucket_name: "photodepot-downloads-local" },
    ],
  }
  await writeFile(
    join(runtime, "wrangler.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`
  )
  await writeFile(
    join(runtime, ".dev.vars"),
    Object.entries(settings)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 }
  )
  for (const name of ["functions", "node_modules"]) {
    try {
      await symlink(join(root, name), join(runtime, name), "dir")
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
  }
  return { runtime, persist: join(runtime, "state") }
}

export async function main(args = process.argv.slice(2), root = repository) {
  const command = args[0]
  if (command === "setup") {
    const index = args.indexOf("--desktop-dir")
    if (index < 0 || !args[index + 1])
      throw new Error(
        "Pass --desktop-dir /absolute/path/to/photodepot to create matching public desktop settings."
      )
    const result = await setupDevelopment(root, resolve(args[index + 1]))
    console.log(
      `Created or retained ${result.secretsPath} and ${result.desktopPath}. Add WorkOS development settings to the server file; no secret was printed.`
    )
    return
  }
  if (!["dev", "migrate"].includes(command))
    throw new Error(
      "Usage: subscription-development.mjs setup --desktop-dir PATH | migrate | dev"
    )
  const { runtime, persist } = await prepareDevelopment(root, command === "dev")
  const cli =
    command === "migrate"
      ? ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist]
      : [
          "pages",
          "dev",
          resolve(root, "out"),
          "--ip",
          "127.0.0.1",
          "--port",
          "8788",
          "--persist-to",
          persist,
        ]
  // Pages reads settings before --cwd middleware runs. Start in the isolated
  // directory so every configuration lookup uses the same authority.
  const child = spawnSync(
    process.execPath,
    [resolve(root, "node_modules/wrangler/bin/wrangler.js"), ...cli],
    {
      cwd: runtime,
      stdio: "inherit",
      env: { ...process.env, WRANGLER_LOG_PATH: join(runtime, "logs") },
    }
  )
  if (child.error) throw child.error
  if (child.status !== 0)
    throw new Error(`Local subscription ${command} failed.`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
