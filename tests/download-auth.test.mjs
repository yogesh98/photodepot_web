import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ACCESS_SECONDS,
  allowPasswordAttempt,
  createAccessToken,
  hasDownloadAccess,
  isArchitecture,
  passwordsMatch,
} from "../lib/download-auth.ts"

const password = "test-password-🗝️"
const now = 1_800_000_000_000
test("password checks fail closed and preserve exact characters", () => {
  assert.equal(passwordsMatch(password, password), true)
  assert.equal(passwordsMatch(`${password} `, password), false)
  assert.equal(passwordsMatch("wrong", password), false)
  assert.equal(passwordsMatch("", ""), false)
  assert.equal(passwordsMatch("x".repeat(1025), "x".repeat(1025)), false)
})
test("only supported architectures are accepted", () => {
  assert.equal(isArchitecture("arm64"), true)
  assert.equal(isArchitecture("x64"), true)
  assert.equal(isArchitecture("../../private"), false)
})
test("access is scoped to a build, expires, and is revoked by password rotation", () => {
  const token = createAccessToken("arm64", password, now)
  assert.equal(hasDownloadAccess(token, "arm64", password, now), true)
  assert.equal(hasDownloadAccess(token, "x64", password, now), false)
  assert.equal(hasDownloadAccess(token, "arm64", "changed", now), false)
  assert.equal(
    hasDownloadAccess(token, "arm64", password, now + ACCESS_SECONDS * 1000),
    false
  )
  assert.equal(hasDownloadAccess(token, "arm64", "", now), false)
  assert.equal(hasDownloadAccess(undefined, "arm64", password, now), false)
})
test("forged, malformed, or extended tokens cannot grant access", () => {
  const token = createAccessToken("arm64", password, now)
  for (const forged of [
    "bad",
    token + ".extra",
    token.replace("arm64", "x64"),
    token.slice(0, -1),
    token.replace(/\.[^.]+$/, "." + "0".repeat(64)),
    token.replace("1800000300", "1800000900"),
  ]) {
    assert.equal(hasDownloadAccess(forged, "arm64", password, now), false)
  }
})
test("password attempts are limited and the window resets", () => {
  for (let i = 0; i < 8; i++)
    assert.equal(allowPasswordAttempt("test-ip", now), true)
  assert.equal(allowPasswordAttempt("test-ip", now), false)
  assert.equal(allowPasswordAttempt("other-ip", now), true)
  assert.equal(allowPasswordAttempt("test-ip", now + 600_000), true)
})
