import assert from "node:assert/strict"
import { test } from "node:test"
import { formatStripePrice } from "../lib/stripe-currency.ts"

for (const [currency, amount, expected] of [
  ["usd", 2000, "$20"],
  ["usd", 2015, "$20.15"],
  ["jpy", 2000, "¥2,000"],
  ["KRW", 2000, "₩2,000"],
  // Stripe treats MGA as zero-decimal even though Intl uses two decimals.
  ["mga", 2000, "MGA 2,000"],
  // ISK and UGX retain two-decimal API amounts for compatibility.
  ["isk", 2000, "ISK 20"],
  ["ugx", 2000, "UGX 20"],
  // HUF and TWD's zero-decimal payout rules do not apply to charges.
  ["huf", 2015, "HUF 20.15"],
  ["twd", 2015, "NT$20.15"],
]) {
  test(`formats Stripe ${currency} amount ${amount} as ${expected}`, () => {
    assert.equal(
      formatStripePrice({ amount, currency }, "en-US").replaceAll(
        "\u00a0",
        " "
      ),
      expected
    )
  })
}
