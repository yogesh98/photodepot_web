import { readdir, rm, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"

export async function assertStaticAssets(directory) {
  const files = []
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else {
        if (
          /\.(dmg|pkg|sqlite(?:-wal|-shm)?)$/i.test(entry.name) ||
          entry.name.startsWith(".env") ||
          entry.name.startsWith(".dev.vars")
        )
          throw new Error(`Private file must not be deployed: ${file}`)
        if ((await stat(file)).size > 25 * 1024 * 1024)
          throw new Error(`Pages asset exceeds 25 MiB: ${file}`)
        files.push(relative(directory, file).replaceAll("\\", "/"))
      }
    }
  }
  await visit(directory)
  return files
}

export async function preparePages(directory = "out") {
  // Capture sources and regeneration tooling are retained in the repository,
  // but are not website assets.
  for (const source of ["demo-source", "local-ai-source"])
    await rm(join(directory, "screenshots", source), {
      recursive: true,
      force: true,
    })
  const files = await assertStaticAssets(directory)
  const hashed = files
    .filter((file) =>
      /^screenshots\/[a-z-]+\.[a-f0-9]{12}\.(gif|png|webp|mp4)$/.test(file)
    )
    .sort()
  const headers = [
    "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Robots-Tag: noindex, nofollow",
    "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable",
    ...hashed.map(
      (file) => `/${file}\n  Cache-Control: public, max-age=31536000, immutable`
    ),
  ]
  if (headers.length > 100) throw new Error("Too many Pages header rules")
  await writeFile(join(directory, "_headers"), `${headers.join("\n\n")}\n`)
  console.log(
    `Pages assets verified: ${files.length} files; installers excluded.`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "prepare") await preparePages()
  else if (process.argv[2] === "check")
    await assertStaticAssets(process.argv[3] || "out")
  else throw new Error("Usage: pages-assets.mjs prepare | check [directory]")
}
