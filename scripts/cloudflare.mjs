import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { DOWNLOAD_FILES } from "../lib/download-files.ts"
import { assertStaticAssets } from "./pages-assets.mjs"
import { parseCloudflareConfig } from "./cloudflare-config.mjs"

const configPath = new URL("../wrangler.jsonc", import.meta.url)
const config = parseCloudflareConfig(await readFile(configPath, "utf8"))
const bucket = config.r2_buckets[0].bucket_name
const databaseName = config.d1_databases[0].database_name
const local = process.argv.includes("--local")
const env = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/logs" }
env.CLOUDFLARE_ACCOUNT_ID ||= "4eeb0b99da9819cbbf7adbe6fc8bfc1c"

function wrangler(args, capture = false) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    env,
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`Wrangler failed: ${args.slice(0, 3).join(" ")}`)
  return result.stdout
}

async function setup() {
  // A failed R2 check must stop setup, rather than accidentally selecting another
  // account or proceeding without the required storage subscription.
  const buckets = wrangler(["r2", "bucket", "list"], true)
  if (!new RegExp(`^name:\\s+${bucket}\\s*$`, "m").test(buckets))
    wrangler(["r2", "bucket", "create", bucket])
  let databases = JSON.parse(wrangler(["d1", "list", "--json"], true))
  if (!databases.some((database) => database.name === databaseName)) {
    wrangler([
      "d1",
      "create",
      databaseName,
      "--location",
      "enam",
      "--update-config=false",
    ])
    databases = JSON.parse(wrangler(["d1", "list", "--json"], true))
  }
  const database = databases.find((database) => database.name === databaseName)
  if (!database?.uuid)
    throw new Error("Could not identify the Photodepot D1 database")
  config.d1_databases[0].database_id = database.uuid
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const projects = JSON.parse(
    wrangler(["pages", "project", "list", "--json"], true)
  )
  if (!projects.some((project) => project["Project Name"] === config.name))
    wrangler([
      "pages",
      "project",
      "create",
      config.name,
      "--production-branch",
      "main",
      "--compatibility-date",
      config.compatibility_date,
      "--compatibility-flags",
      "nodejs_compat",
    ])
  wrangler(["d1", "migrations", "apply", "DB", "--remote"])
  console.log(
    "Resources ready. Keep the R2 bucket private; set the Pages password secret and upload installers before deployment."
  )
}

async function upload() {
  // Validate every file before uploading either architecture.
  const files = await Promise.all(
    Object.values(DOWNLOAD_FILES).map(async (name) => {
      const path = `downloads/${name}`
      const info = await stat(path)
      if (!info.isFile() || info.size === 0)
        throw new Error(`Installer unavailable: ${path}`)
      // Wrangler's single-object uploader is limited to 300 MiB. Larger future
      // releases need an S3 multipart uploader, rather than a partial deployment.
      if (info.size > 300 * 1024 * 1024)
        throw new Error(`Use an S3 multipart upload for ${path} (over 300 MiB)`)
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      return { name, path, size: info.size, sha256: hash.digest("hex") }
    })
  )
  for (const file of files) {
    wrangler([
      "r2",
      "object",
      "put",
      `${bucket}/${file.name}`,
      "--file",
      file.path,
      local ? "--local" : "--remote",
      "--content-type",
      "application/octet-stream",
      "--content-disposition",
      `attachment; filename="${file.name}"`,
      "--cache-control",
      "private, no-store",
    ])
    console.log(`${file.name}: ${file.size} bytes; SHA-256 ${file.sha256}`)
  }
}

async function deploy() {
  if (
    config.d1_databases[0].database_id ===
    "00000000-0000-0000-0000-000000000000"
  )
    throw new Error("Run pnpm cf:setup before deploying")
  await assertStaticAssets("out")
  wrangler([
    "pages",
    "deploy",
    "out",
    "--project-name",
    config.name,
    "--branch",
    "main",
  ])
}

try {
  const command = process.argv[2]
  if (command === "setup") await setup()
  else if (command === "upload") await upload()
  else if (command === "deploy") await deploy()
  else
    throw new Error("Usage: cloudflare.mjs setup | upload [--local] | deploy")
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
