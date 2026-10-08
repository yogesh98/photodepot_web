import assert from "node:assert/strict"
import { test } from "node:test"
import { downloadRange } from "../lib/download-files.ts"

test("single byte ranges support offsets, suffixes, open ends, and clamping", () => {
  assert.deepEqual(downloadRange("bytes=2-5", 10), { offset: 2, length: 4 })
  assert.deepEqual(downloadRange("bytes=2-", 10), { offset: 2, length: 8 })
  assert.deepEqual(downloadRange("bytes=-3", 10), { offset: 7, length: 3 })
  assert.deepEqual(downloadRange("bytes=-30", 10), { offset: 0, length: 10 })
  assert.deepEqual(downloadRange("bytes=2-99", 10), { offset: 2, length: 8 })
  for (const value of [
    "bytes=10-",
    "bytes=4-2",
    "bytes=-0",
    "bytes=9007199254740993-",
  ])
    assert.equal(downloadRange(value, 10), false)
  for (const value of [null, "invalid", "bytes=-", "bytes=0-1,3-4"])
    assert.equal(downloadRange(value, 10), null)
})
