import assert from "node:assert/strict"
import { test } from "node:test"
import { validateWaitlistEntry } from "../lib/waitlist-validation.ts"

const valid = {
  firstName: "Alex",
  lastName: "",
  email: "alex@example.com",
  heardAboutUs: "A friend",
}

test("required fields reject missing, blank, malformed and non-string values", () => {
  for (const value of [null, [], "hello", {}]) {
    assert.equal(validateWaitlistEntry(value).ok, false)
  }
  for (const field of ["firstName", "email", "heardAboutUs"]) {
    for (const value of [undefined, "", "   ", 123, {}]) {
      assert.equal(
        validateWaitlistEntry({ ...valid, [field]: value }).ok,
        false
      )
    }
  }
  for (const email of [
    "no-at-sign",
    "alex@",
    "@example.com",
    "alex @example.com",
  ]) {
    assert.equal(validateWaitlistEntry({ ...valid, email }).ok, false)
  }
  assert.equal(validateWaitlistEntry({ ...valid, lastName: 123 }).ok, false)
})

test("last name is optional and answers are trimmed, with normalized email", () => {
  const withoutLastName = { ...valid }
  delete withoutLastName.lastName
  assert.deepEqual(validateWaitlistEntry(withoutLastName), {
    ok: true,
    entry: valid,
  })
  assert.deepEqual(
    validateWaitlistEntry({
      firstName: "  Alex  ",
      lastName: "  O'Connor  ",
      email: "  ALEX@Example.com ",
      heardAboutUs: "  Instagram  ",
    }),
    {
      ok: true,
      entry: {
        firstName: "Alex",
        lastName: "O'Connor",
        email: "alex@example.com",
        heardAboutUs: "Instagram",
      },
    }
  )
})

test("field lengths are bounded before writing to disk", () => {
  for (const [field, length] of [
    ["firstName", 101],
    ["lastName", 101],
    ["email", 255],
    ["heardAboutUs", 501],
  ]) {
    assert.equal(
      validateWaitlistEntry({ ...valid, [field]: "x".repeat(length) }).ok,
      false
    )
  }
})
