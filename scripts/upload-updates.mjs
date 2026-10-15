import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { load, JSON_SCHEMA } from "js-yaml"
import {
  isStableVersion,
  updateObjectKey,
  UPDATE_ARTIFACT_CACHE,
  UPDATE_FEED_CACHE,
} from "../lib/update-files.ts"
import { parseCloudflareConfig } from "./cloudflare-config.mjs"

export const MAX_UPLOAD_SIZE = 300 * 1024 * 1024
const architectures = ["arm64", "x64"]

async function inspectFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0)
    throw new Error(`Update artifact must be a nonempty regular file: ${path}`)
  if (info.size > MAX_UPLOAD_SIZE)
    throw new Error(`Use an S3 multipart upload for ${path} (over 300 MiB)`)
  const hash = createHash("sha512")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { path, size: info.size, sha512: hash.digest("base64") }
}

// Complete validation precedes all storage writes, including either feed.
export async function validateUpdateRelease(source) {
  const releases = []
  for (const architecture of architectures) {
    const directory = join(source, architecture)
    const feed = await inspectFile(join(directory, "latest-mac.yml"))
    const manifest = load(await readFile(feed.path, "utf8"), {
      schema: JSON_SCHEMA,
    })
    if (!manifest || !isStableVersion(manifest.version))
      throw new Error(`Invalid stable version in ${feed.path}`)
    const filename = `photodepot-${manifest.version}-${architecture}.zip`
    if (
      !Array.isArray(manifest.files) ||
      manifest.files.length !== 1 ||
      manifest.files[0]?.url !== filename ||
      manifest.path !== filename ||
      !updateObjectKey(architecture, filename)
    )
      throw new Error(`Feed must reference only ${filename}: ${feed.path}`)
    const zip = await inspectFile(join(directory, filename))
    if (
      manifest.files[0].sha512 !== zip.sha512 ||
      manifest.sha512 !== zip.sha512 ||
      manifest.files[0].size !== zip.size
    )
      throw new Error(`ZIP SHA-512 or size mismatch: ${zip.path}`)
    const blockmap = await inspectFile(join(directory, `${filename}.blockmap`))
    if (
      manifest.files[0].blockMapSize !== undefined &&
      manifest.files[0].blockMapSize !== blockmap.size
    )
      throw new Error(`Blockmap size mismatch: ${blockmap.path}`)
    const withKey = (file, name) => ({
      ...file,
      key: updateObjectKey(architecture, name),
      contentType:
        name === "latest-mac.yml"
          ? "application/yaml; charset=utf-8"
          : "application/octet-stream",
      cacheControl:
        name === "latest-mac.yml" ? UPDATE_FEED_CACHE : UPDATE_ARTIFACT_CACHE,
    })
    releases.push({
      architecture,
      version: manifest.version,
      artifacts: [
        withKey(zip, filename),
        withKey(blockmap, `${filename}.blockmap`),
      ],
      feed: withKey(feed, "latest-mac.yml"),
    })
  }
  if (releases[0].version !== releases[1].version)
    throw new Error("Both update architectures must have the same version")
  return releases
}

function sameBytes(left, right) {
  return left.size === right.size && left.sha512 === right.sha512
}

// The transport must distinguish a missing object (null) from read failures.
// Existing versioned bytes are never intentionally replaced. Run one publisher
// at a time: Wrangler does not expose conditional create for R2 objects.
export async function publishUpdateRelease(releases, storage) {
  const artifacts = releases.flatMap((release) => release.artifacts)
  const missing = []
  for (const artifact of artifacts) {
    const existing = await storage.inspect(artifact.key)
    if (!existing) missing.push(artifact)
    else if (!sameBytes(existing, artifact))
      throw new Error(`Refusing to replace immutable update: ${artifact.key}`)
  }
  for (const artifact of missing) await storage.put(artifact)
  // Read every binary back from storage before making either version visible.
  for (const artifact of artifacts) {
    const uploaded = await storage.inspect(artifact.key)
    if (!uploaded || !sameBytes(uploaded, artifact))
      throw new Error(`Uploaded update verification failed: ${artifact.key}`)
  }
  for (const release of releases) {
    await storage.put(release.feed)
    const uploaded = await storage.inspect(release.feed.key)
    if (!uploaded || !sameBytes(uploaded, release.feed))
      throw new Error(`Published feed verification failed: ${release.feed.key}`)
  }
}

function wranglerTransport(bucket, local, temporary) {
  const env = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/logs" }
  env.CLOUDFLARE_ACCOUNT_ID ||= "4eeb0b99da9819cbbf7adbe6fc8bfc1c"
  let sequence = 0
  const run = (args) => {
    const result = spawnSync(
      "pnpm",
      ["exec", "wrangler", "r2", "object", ...args],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }
    )
    if (result.error) throw result.error
    return result
  }
  const location = local ? "--local" : "--remote"
  return {
    async inspect(key) {
      const path = join(temporary, `verify-${sequence++}`)
      const result = run(["get", `${bucket}/${key}`, "--file", path, location])
      if (result.status !== 0) {
        if (result.stderr.includes("The specified key does not exist."))
          return null
        throw new Error(`Cannot read ${key}: ${result.stderr.trim()}`)
      }
      return inspectFile(path)
    },
    async put(file) {
      const result = run([
        "put",
        `${bucket}/${file.key}`,
        "--file",
        file.path,
        location,
        "--content-type",
        file.contentType,
        "--cache-control",
        file.cacheControl,
      ])
      if (result.status !== 0)
        throw new Error(`Cannot upload ${file.key}: ${result.stderr.trim()}`)
      console.log(`${file.key}: ${file.size} bytes; SHA-512 ${file.sha512}`)
    },
  }
}

export async function uploadUpdates(args) {
  const options = args.filter((argument) => argument !== "--")
  const local = options.includes("--local")
  const sourceIndex = options.indexOf("--source")
  const source = sourceIndex >= 0 ? options[sourceIndex + 1] : undefined
  const allowed = new Set(["--local", "--source", source])
  if (
    !source ||
    source.startsWith("--") ||
    options.some((option) => !allowed.has(option))
  )
    throw new Error(
      "Usage: pnpm updates:upload --source <release/updates> [--local]"
    )
  const config = parseCloudflareConfig(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
  )
  const bucket = config.r2_buckets.find(
    (binding) => binding.binding === "DOWNLOADS"
  )?.bucket_name
  if (!bucket) throw new Error("DOWNLOADS R2 binding is missing")
  const temporary = await mkdtemp(join(tmpdir(), "photodepot-update-upload-"))
  try {
    const releases = await validateUpdateRelease(resolve(source))
    // Snapshot validated files so build output changes cannot invalidate hashes
    // between preflight and publication.
    for (const file of releases.flatMap((release) => [
      ...release.artifacts,
      release.feed,
    ])) {
      const snapshot = join(
        temporary,
        `publish-${file.key.replaceAll("/", "-")}`
      )
      await copyFile(file.path, snapshot)
      const copied = await inspectFile(snapshot)
      if (!sameBytes(copied, file))
        throw new Error(`Build output changed: ${file.path}`)
      file.path = snapshot
    }
    await publishUpdateRelease(
      releases,
      wranglerTransport(bucket, local, temporary)
    )
    console.log(`Published macOS ${releases[0].version} for arm64 and x64.`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await uploadUpdates(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
