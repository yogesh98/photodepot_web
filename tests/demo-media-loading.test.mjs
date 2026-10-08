import assert from "node:assert/strict"
import { after, test } from "node:test"
import {
  preloadDemoVideo,
  warmDemoVideo,
} from "../components/landing/demo-media-loading.ts"

const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
)
let reducedMotion = false
const connection = { saveData: false }
globalThis.window = { matchMedia: () => ({ matches: reducedMotion }) }
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { connection },
})
const blobUrls = []
after(() => {
  globalThis.window = originalWindow
  globalThis.fetch = originalFetch
  if (originalNavigator)
    Object.defineProperty(globalThis, "navigator", originalNavigator)
  else delete globalThis.navigator
  for (const url of blobUrls) URL.revokeObjectURL(url)
})

test("preloading and playback share one download, including subsequent tab visits", async () => {
  let downloads = 0
  let finish
  globalThis.fetch = () => {
    downloads++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const preloaded = preloadDemoVideo("/shared.mp4")
  const playback = preloadDemoVideo("/shared.mp4", "auto")
  assert.equal(downloads, 1)
  finish(
    new Response("compressed media", {
      headers: { "Content-Type": "video/mp4" },
    })
  )
  const url = await preloaded
  blobUrls.push(url)
  assert.match(url, /^blob:/)
  assert.equal(await playback, url)
  assert.equal(await preloadDemoVideo("/shared.mp4"), url)
  assert.equal(downloads, 1)
})

test("failed HTTP and network downloads leave the poster available and can be retried", async () => {
  for (const [src, failure] of [
    [
      "/missing.mp4",
      () => Promise.resolve(new Response(null, { status: 404 })),
    ],
    ["/offline.mp4", () => Promise.reject(new Error("offline"))],
  ]) {
    globalThis.fetch = failure
    assert.equal(await preloadDemoVideo(src), null)
    globalThis.fetch = () => Promise.resolve(new Response("media"))
    const url = await preloadDemoVideo(src)
    blobUrls.push(url)
    assert.match(url, /^blob:/)
  }
})

test("reduced motion prevents animated media downloads", async () => {
  reducedMotion = true
  globalThis.fetch = () => assert.fail("No video should be downloaded")
  assert.equal(await preloadDemoVideo("/reduced.mp4"), null)
  warmDemoVideo("/reduced.mp4")
  reducedMotion = false
})

test("Save-Data skips speculative downloads while permitting a viewed demo", async () => {
  connection.saveData = true
  let downloads = 0
  globalThis.fetch = () => {
    downloads++
    return Promise.resolve(new Response("media"))
  }
  warmDemoVideo("/save-data.mp4")
  assert.equal(downloads, 0)
  const url = await preloadDemoVideo("/save-data.mp4", "auto")
  blobUrls.push(url)
  assert.match(url, /^blob:/)
  assert.equal(downloads, 1)
  connection.saveData = false
})
