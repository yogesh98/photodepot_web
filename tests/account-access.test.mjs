import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveAccountAccess } from "../lib/account-access.ts"
import { LICENSE_GRACE_MS } from "../lib/license-crypto.ts"

const now = 1_800_000_000_000
const manual = {
  type: "regular",
  status: "active",
  startsAt: now - 1,
  endsAt: now + 30 * 86_400_000,
  remindersEnabled: true,
}
const managed = {
  userId: "user_paid",
  organizationId: "org_paid",
  enabled: true,
  issuedAt: now - 1,
  expiresAt: now + 300_000,
  revision: 1,
}

test("historical manual grants never authorize local use or hosting", () => {
  for (const grant of [
    null,
    manual,
    { ...manual, type: "trial" },
    { ...manual, status: "revoked" },
    { ...manual, endsAt: now },
  ]) {
    const access = resolveAccountAccess(grant, now)
    assert.deepEqual(access, {
      tier: "free",
      status: "none",
      source: null,
      startsAt: null,
      endsAt: null,
      canUseLocal: false,
      canHost: false,
    })
  }
})
test("only current enabled WorkOS proof authorizes a fixed subscription allowance", () => {
  for (const grant of [null, manual]) {
    const access = resolveAccountAccess(grant, now, managed)
    assert.equal(access.tier, "standard")
    assert.equal(access.source, "workos")
    assert.equal(access.canHost, true)
    assert.equal(access.canUseLocal, true)
    assert.equal(access.endsAt, managed.issuedAt + LICENSE_GRACE_MS)
  }
})
test("disabled, expired, future and exhausted WorkOS proof fail closed despite manual history", () => {
  for (const proof of [
    { ...managed, enabled: false },
    { ...managed, expiresAt: now },
    { ...managed, issuedAt: now + 1 },
    { ...managed, issuedAt: now - LICENSE_GRACE_MS },
  ]) {
    const access = resolveAccountAccess(manual, now, proof)
    assert.equal(access.canHost, false)
    assert.equal(access.canUseLocal, false)
    assert.equal(access.tier, "free")
  }
})
