import assert from "node:assert/strict"
import { test } from "node:test"
import {
  resolveAccountAccess,
  trialReminderEligible,
} from "../lib/account-access.ts"

const now = 1_800_000_000_000
const grant = {
  type: "trial",
  status: "active",
  startsAt: now - 1,
  endsAt: now + 1,
  remindersEnabled: true,
}
test("one access decision covers Free, Trial, Standard, expiry, revocation and future starts", () => {
  const cases = [
    [null, "free", "none", false],
    [grant, "trial", "active", true],
    [{ ...grant, type: "regular" }, "standard", "active", true],
    [{ ...grant, endsAt: now }, "free", "expired", false],
    [{ ...grant, status: "revoked" }, "free", "revoked", false],
    [{ ...grant, startsAt: now + 1 }, "free", "active", false],
  ]
  for (const [input, tier, status, allowed] of cases) {
    const access = resolveAccountAccess(input, now)
    assert.equal(access.tier, tier)
    assert.equal(access.status, status)
    assert.equal(access.canUseLocal, allowed)
    assert.equal(access.canHost, allowed)
    assert.equal(access.source, input ? "manual" : null)
  }
})
test("trial reminders use the same active grant decision and an independent preference", () => {
  assert.equal(trialReminderEligible(grant, now), true)
  for (const input of [
    null,
    { ...grant, remindersEnabled: false },
    { ...grant, status: "revoked" },
    { ...grant, type: "regular" },
    { ...grant, endsAt: now },
    { ...grant, startsAt: now + 1 },
  ])
    assert.equal(trialReminderEligible(input, now), false)
})
