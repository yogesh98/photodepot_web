import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { assertStaticAssets, preparePages } from "../scripts/pages-assets.mjs"

test("static deployment rejects installers, private data and oversized assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "photodepot-assets-"))
  try {
    for (const name of [
      "installer.dmg",
      "Installer.DMG",
      "waitlist.sqlite",
      "waitlist.sqlite-wal",
      ".env.local",
      ".dev.vars",
      ".dev.vars.production",
    ]) {
      await writeFile(join(directory, name), "private")
      await assert.rejects(assertStaticAssets(directory), /Private file/)
      await rm(join(directory, name))
    }
    await writeFile(
      join(directory, "large.mp4"),
      Buffer.alloc(25 * 1024 * 1024 + 1)
    )
    await assert.rejects(assertStaticAssets(directory), /exceeds 25 MiB/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("only content-hashed assets receive immutable cache headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "photodepot-headers-"))
  try {
    await mkdir(join(directory, "screenshots", "demo-source"), {
      recursive: true,
    })
    await writeFile(
      join(directory, "screenshots", "demo-source", "source.png"),
      "source"
    )
    await writeFile(
      join(directory, "screenshots", "demo.012345abcdef.mp4"),
      "video"
    )
    await writeFile(join(directory, "screenshots", "demo.png"), "image")
    await preparePages(directory)
    const headers = await readFile(join(directory, "_headers"), "utf8")
    assert.ok(
      headers.includes(
        "/screenshots/demo.012345abcdef.mp4\n  Cache-Control: public, max-age=31536000, immutable"
      )
    )
    assert.ok(!headers.includes("/screenshots/demo.png"))
    assert.ok(
      !(await assertStaticAssets(directory)).includes(
        "screenshots/demo-source/source.png"
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
