import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  DOWNLOAD_FILES,
  downloadExists,
  downloadPath,
  isDownloadAsset,
  openDownload,
} from "../lib/download-files.ts"

test("direct installer assets are blocked, including encoded and normalized paths", () => {
  for (const path of [
    "/downloads",
    "/downloads/photodepot-0.1.0-arm64.dmg",
    "/%64ownloads/photodepot-0.1.0-x64.dmg",
    "/downloads%2Fphotodepot.dmg",
    "/brand/%2e%2e/downloads/file.dmg",
    "/brand%2f..%2fdownloads/file.dmg",
    "/downloads%5cfile.dmg",
    "/Downloads/file.dmg",
    "/downloads/%invalid",
  ])
    assert.equal(isDownloadAsset(path), true, path)
  for (const path of [
    "/",
    "/api/download/arm64",
    "/brand/photodepot.png",
    "/_next/static/app.js",
    "/downloadsomething",
  ]) {
    assert.equal(isDownloadAsset(path), false, path)
  }
})

test("missing, empty and non-file installers fail closed; available installers stream from disk", async () => {
  const original = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), "photodepot-files-"))
  try {
    process.chdir(directory)
    await mkdir(join(directory, "public", "downloads"), { recursive: true })
    assert.equal(await downloadExists("arm64"), false)
    await assert.rejects(openDownload("arm64"))
    await writeFile(downloadPath("arm64"), "")
    assert.equal(await downloadExists("arm64"), false)
    await assert.rejects(openDownload("arm64"))
    await mkdir(downloadPath("x64"))
    assert.equal(await downloadExists("x64"), false)
    await assert.rejects(openDownload("x64"))
    const bytes = Buffer.from("installer fixture")
    await writeFile(downloadPath("arm64"), bytes)
    assert.equal(await downloadExists("arm64"), true)
    const file = await openDownload("arm64")
    assert.equal(file.name, DOWNLOAD_FILES.arm64)
    assert.equal(file.size, bytes.length)
    assert.deepEqual(
      Buffer.from(await new Response(file.stream).arrayBuffer()),
      bytes
    )
  } finally {
    process.chdir(original)
    await rm(directory, { recursive: true, force: true })
  }
})
