import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { dump } from "js-yaml"
import {
  MAX_UPLOAD_SIZE,
  publishUpdateRelease,
  validateUpdateRelease,
} from "../scripts/upload-updates.mjs"

async function fixture(run) {
  const source = await mkdtemp(join(tmpdir(), "photodepot-update-test-"))
  const manifests = {}
  const feed = (architecture) => join(source, architecture, "latest-mac.yml")
  try {
    for (const architecture of ["arm64", "x64"]) {
      await mkdir(join(source, architecture))
      const zip = Buffer.from(`signed ${architecture} ZIP fixture`)
      const name = `photodepot-0.3.0-${architecture}.zip`
      const sha512 = createHash("sha512").update(zip).digest("base64")
      manifests[architecture] = {
        version: "0.3.0",
        files: [{ url: name, sha512, size: zip.length }],
        path: name,
        sha512,
        releaseDate: "2026-10-15T00:00:00.000Z",
      }
      await writeFile(join(source, architecture, name), zip)
      await writeFile(
        join(source, architecture, `${name}.blockmap`),
        "blockmap fixture"
      )
      await writeFile(feed(architecture), dump(manifests[architecture]))
    }
    await run({ source, manifests, feed })
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}

function storageFixture(releases) {
  const events = []
  const objects = new Map()
  const storage = {
    async inspect(key) {
      events.push(["inspect", key])
      return objects.get(key) ?? null
    },
    async put(file) {
      events.push(["put", file.key])
      objects.set(file.key, file)
    },
  }
  return { releases, objects, events, storage }
}

test("both validated architectures publish binaries first, verify all bytes, then publish feeds", async () => {
  await fixture(async ({ source }) => {
    const releases = await validateUpdateRelease(source)
    const { events, storage, objects } = storageFixture(releases)
    const historical = "updates/macos/arm64/photodepot-0.2.0-arm64.zip"
    objects.set(historical, { size: 10, sha512: "old" })
    await publishUpdateRelease(releases, storage)
    const firstFeed = events.findIndex(
      ([action, key]) => action === "put" && key.endsWith("latest-mac.yml")
    )
    for (const artifact of releases.flatMap((release) => release.artifacts)) {
      const writes = events
        .map(([action, key], index) =>
          action === "put" && key === artifact.key ? index : -1
        )
        .filter((index) => index >= 0)
      assert.equal(writes.length, 1)
      assert.ok(writes[0] < firstFeed)
      assert.ok(
        events
          .slice(writes[0] + 1, firstFeed)
          .some(([action, key]) => action === "inspect" && key === artifact.key)
      )
    }
    assert.ok(objects.has(historical))
    assert.equal(objects.size, 7)
    // Retrying a release verifies and reuses immutable binaries.
    events.length = 0
    await publishUpdateRelease(releases, storage)
    assert.equal(events.filter(([action]) => action === "put").length, 2)
  })
})

test("existing conflicting versioned files and failed verification prevent feed publication", async () => {
  await fixture(async ({ source }) => {
    const releases = await validateUpdateRelease(source)
    const first = releases[0].artifacts[0]
    const conflict = storageFixture(releases)
    conflict.objects.set(first.key, { ...first, sha512: "conflicting" })
    await assert.rejects(
      publishUpdateRelease(releases, conflict.storage),
      /Refusing to replace immutable/
    )
    assert.equal(
      conflict.events.filter(([action]) => action === "put").length,
      0
    )
    const corrupt = storageFixture(releases)
    corrupt.storage.put = async (file) => {
      corrupt.events.push(["put", file.key])
      corrupt.objects.set(file.key, { ...file, sha512: "corrupt" })
    }
    await assert.rejects(
      publishUpdateRelease(releases, corrupt.storage),
      /verification failed/
    )
    assert.equal(
      corrupt.events.some(
        ([action, key]) => action === "put" && key.endsWith("latest-mac.yml")
      ),
      false
    )
    const offline = storageFixture(releases)
    offline.storage.inspect = async () => {
      throw new Error("storage offline")
    }
    await assert.rejects(
      publishUpdateRelease(releases, offline.storage),
      /storage offline/
    )
    assert.equal(offline.events.length, 0)
  })
})

test("uploader rejects missing architecture, blockmap, empty files and over-300-MiB files", async () => {
  await fixture(async ({ source, feed }) => {
    const path = join(source, "x64", "photodepot-0.3.0-x64.zip.blockmap")
    const original = await readFile(path)
    await rm(path)
    await assert.rejects(validateUpdateRelease(source), /ENOENT/)
    await writeFile(path, "")
    await assert.rejects(validateUpdateRelease(source), /nonempty regular file/)
    await truncate(path, MAX_UPLOAD_SIZE + 1)
    await assert.rejects(validateUpdateRelease(source), /over 300 MiB/)
    await writeFile(path, original)
    await rm(feed("x64"))
    await assert.rejects(validateUpdateRelease(source), /ENOENT/)
  })
})

test("untrusted manifests cannot choose paths, URLs, architectures, channels, or mismatched ZIP bytes", async () => {
  await fixture(async ({ source, manifests, feed }) => {
    const original = structuredClone(manifests.x64)
    for (const mutate of [
      (manifest) => {
        manifest.files[0].url = "../private.zip"
      },
      (manifest) => {
        manifest.files[0].url = "https://other.example/payload.zip"
      },
      (manifest) => {
        manifest.files[0].url = "photodepot-0.3.0-arm64.zip"
      },
      (manifest) => {
        manifest.path = "photodepot-0.3.0-x64.dmg"
      },
      (manifest) => {
        manifest.files.push({ url: "extra.dmg" })
      },
      (manifest) => {
        manifest.version = "0.3.0-beta.1"
      },
      (manifest) => {
        manifest.files[0].sha512 = "incorrect"
      },
      (manifest) => {
        manifest.sha512 = "incorrect"
      },
      (manifest) => {
        manifest.files[0].size++
      },
      (manifest) => {
        manifest.files[0].blockMapSize = 999
      },
    ]) {
      const manifest = structuredClone(original)
      mutate(manifest)
      await writeFile(feed("x64"), dump(manifest))
      await assert.rejects(validateUpdateRelease(source))
    }
    await writeFile(feed("x64"), "version: 0.3.0\nversion: 0.4.0\n")
    await assert.rejects(
      validateUpdateRelease(source),
      /duplicated mapping key/
    )
  })
})

test("a valid but different version for the second architecture cannot publish a split release", async () => {
  await fixture(async ({ source, manifests, feed }) => {
    const manifest = manifests.x64
    const oldName = manifest.path
    manifest.version = "0.3.1"
    manifest.path = manifest.files[0].url = "photodepot-0.3.1-x64.zip"
    await writeFile(
      join(source, "x64", manifest.path),
      await readFile(join(source, "x64", oldName))
    )
    await writeFile(
      join(source, "x64", `${manifest.path}.blockmap`),
      "blockmap fixture"
    )
    await writeFile(feed("x64"), dump(manifest))
    await assert.rejects(validateUpdateRelease(source), /same version/)
  })
})
