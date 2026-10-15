import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { getPlatformProxy } from "wrangler"
import { handleUpdate } from "../functions/api/updates/macos/[architecture]/[filename].ts"
import { updateObjectKey } from "../lib/update-files.ts"

let platform
let env
const bytes = new TextEncoder().encode("signed updater archive fixture")
const filename = (architecture) => `photodepot-0.3.0-${architecture}.zip`
const request = (
  architecture,
  name,
  method = "GET",
  headers = {},
  bindings = env
) =>
  handleUpdate(
    new Request(
      `https://photodepot.app/api/updates/macos/${architecture}/${name}`,
      {
        method,
        headers,
      }
    ),
    bindings,
    architecture,
    name
  )

before(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
    remoteBindings: false,
    envFiles: [],
  })
  env = platform.env
  for (const architecture of ["arm64", "x64"])
    for (const name of [
      "latest-mac.yml",
      filename(architecture),
      `${filename(architecture)}.blockmap`,
    ])
      await env.DOWNLOADS.put(updateObjectKey(architecture, name), bytes)
})
after(async () => {
  await platform?.dispose()
})

test("updater feeds and artifacts are public, isolated by architecture, and cached appropriately", async () => {
  for (const architecture of ["arm64", "x64"]) {
    for (const name of [
      "latest-mac.yml",
      filename(architecture),
      `${filename(architecture)}.blockmap`,
    ]) {
      const response = await request(architecture, name)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("content-length"), String(bytes.length))
      assert.equal(
        response.headers.get("cache-control"),
        name === "latest-mac.yml"
          ? "no-store"
          : "public, max-age=31536000, immutable"
      )
      assert.equal(response.headers.get("set-cookie"), null)
      assert.equal(response.headers.get("location"), null)
      assert.ok(response.headers.get("etag"))
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
      const head = await request(architecture, name, "HEAD", {
        range: "bytes=0-1",
      })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get("content-length"), String(bytes.length))
      assert.equal(await head.text(), "")
    }
  }
})

test("ZIP and blockmap ranges honor strong If-Range and reject unsatisfiable offsets", async () => {
  for (const name of [filename("arm64"), `${filename("arm64")}.blockmap`]) {
    const metadata = await env.DOWNLOADS.head(updateObjectKey("arm64", name))
    for (const [range, offset, length] of [
      ["bytes=2-5", 2, 4],
      ["bytes=2-", 2, bytes.length - 2],
      ["bytes=-3", bytes.length - 3, 3],
    ]) {
      const response = await request("arm64", name, "GET", {
        range,
        "if-range": metadata.httpEtag,
      })
      assert.equal(response.status, 206)
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${offset}-${offset + length - 1}/${bytes.length}`
      )
      assert.equal(response.headers.get("content-length"), String(length))
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        bytes.slice(offset, offset + length)
      )
    }
    for (const ifRange of [
      '"stale"',
      `W/${metadata.httpEtag}`,
      metadata.uploaded.toUTCString(),
    ]) {
      const full = await request("arm64", name, "GET", {
        range: "bytes=0-1",
        "if-range": ifRange,
      })
      assert.equal(full.status, 200)
      assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes)
    }
    const invalid = await request("arm64", name, "GET", { range: "bytes=999-" })
    assert.equal(invalid.status, 416)
    assert.equal(
      invalid.headers.get("content-range"),
      `bytes */${bytes.length}`
    )
    const multiple = await request("arm64", name, "GET", {
      range: "bytes=0-1,3-4",
    })
    assert.equal(multiple.status, 200)
  }
})

test("ETag conditional requests return a bodyless 304", async () => {
  const first = await request("arm64", "latest-mac.yml", "HEAD")
  for (const tag of [
    first.headers.get("etag"),
    `W/${first.headers.get("etag")}`,
    '"other", *',
  ]) {
    const response = await request("arm64", "latest-mac.yml", "GET", {
      "if-none-match": tag,
    })
    assert.equal(response.status, 304)
    assert.equal(await response.text(), "")
    assert.equal(response.headers.get("content-length"), null)
  }
})

test("unsafe paths, cross-architecture files, other channels and methods never reach storage", async () => {
  const bindings = {
    DOWNLOADS: { head: () => assert.fail("Invalid request reached R2") },
  }
  for (const [architecture, name] of [
    ["ARM64", "latest-mac.yml"],
    ["../../private", "latest-mac.yml"],
    ["arm64", filename("x64")],
    ["arm64", "../latest-mac.yml"],
    ["arm64", "%2e%2e%2flatest-mac.yml"],
    ["arm64", "beta-mac.yml"],
    ["arm64", "photodepot-0.3.0-arm64.dmg"],
    ["arm64", "photodepot-00.3.0-arm64.zip"],
  ]) {
    const response = await request(architecture, name, "GET", {}, bindings)
    assert.equal(response.status, 404)
    assert.equal(response.headers.get("location"), null)
  }
  const response = await request(
    "arm64",
    "latest-mac.yml",
    "POST",
    {},
    bindings
  )
  assert.equal(response.status, 405)
  assert.equal(response.headers.get("allow"), "GET, HEAD")
})

test("missing objects return 404, storage failures or metadata races return 503 without redirects", async () => {
  const metadata = await env.DOWNLOADS.head(
    updateObjectKey("arm64", filename("arm64"))
  )
  for (const [bindings, status] of [
    [{ DOWNLOADS: { head: async () => null } }, 404],
    [{ DOWNLOADS: { head: async () => ({ size: 0 }) } }, 404],
    [{}, 503],
    [
      {
        DOWNLOADS: {
          head: () => {
            throw new Error("offline")
          },
        },
      },
      503,
    ],
    [
      {
        DOWNLOADS: {
          head: async () => metadata,
          get: async (_key, options) => {
            assert.deepEqual(options.onlyIf, { etagMatches: metadata.etag })
            return metadata
          },
        },
      },
      503,
    ],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      // HEAD needs no body read and cannot observe the metadata/body race.
      if (method === "HEAD" && bindings.DOWNLOADS?.get) continue
      const response = await request(
        "arm64",
        filename("arm64"),
        method,
        {},
        bindings
      )
      assert.equal(response.status, status)
      assert.equal(response.headers.get("location"), null)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      if (method === "GET")
        assert.equal(typeof (await response.json()).error, "string")
      else assert.equal(await response.text(), "")
    }
  }
})
