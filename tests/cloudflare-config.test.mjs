import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { parseCloudflareConfig } from "../scripts/cloudflare-config.mjs"

test("Cloudflare deployment accepts JSONC comments and trailing commas", async () => {
  assert.deepEqual(
    parseCloudflareConfig('{ // comment\n"url": "https://example.com", }'),
    { url: "https://example.com" }
  )
  const actual = parseCloudflareConfig(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
  )
  assert.equal(actual.name, "photodepot-web")
  assert.equal(actual.r2_buckets[0].binding, "DOWNLOADS")
  assert.throws(() => parseCloudflareConfig('{ "name": }'), /Invalid wrangler/)
})
