import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { onRequest } from "../functions/_middleware.ts"

// Routing is part of the security boundary: no alternate static path may skip middleware.
test("Pages routes send all admin shell URLs to fail-closed middleware", async () => {
  const routes = JSON.parse(
    await readFile(new URL("../public/_routes.json", import.meta.url), "utf8")
  )
  assert.ok(routes.include.includes("/api/*"))
  assert.ok(routes.include.includes("/admin"))
  assert.ok(routes.include.includes("/admin/*"))
  assert.deepEqual(routes.exclude, [])
  for (const host of [
    "photodepot.app",
    "photodepot-web.pages.dev",
    "preview.photodepot-web.pages.dev",
  ]) {
    for (const path of [
      "/admin",
      "/admin/licenses",
      "/admin/licenses.html",
      "/admin/licenses.txt",
      "/admin/subscriptions",
      "/admin/subscriptions/",
      "/admin/subscriptions.html",
      "/admin/subscriptions.txt",
    ]) {
      let called = false
      const response = await onRequest({
        request: new Request(`https://${host}${path}`),
        env: {},
        next: async () => {
          called = true
          return new Response("sensitive shell")
        },
      })
      assert.equal(response.status, 503)
      assert.equal(response.headers.get("cache-control"), "private, no-store")
      assert.equal(called, false)
    }
  }
})
test("public assets and desktop verification bypass only the admin shell authentication", async () => {
  for (const path of [
    "/",
    "/tester",
    "/api/licenses/verify",
    "/_next/static/dashboard.js",
  ]) {
    const response = await onRequest({
      request: new Request(`https://photodepot.app${path}`),
      env: {},
      next: async () => new Response("allowed downstream"),
    })
    assert.equal(await response.text(), "allowed downstream")
  }
})
