// Stripe charge amounts use these zero-decimal currencies, not Intl's currency
// precision. ISK/UGX retain two-decimal API amounts; HUF/TWD charges also use two.
// https://docs.stripe.com/currencies#zero-decimal
const zeroDecimalCurrencies = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
])

export function formatStripePrice(
  price: { amount: number; currency: string },
  locale?: string
) {
  const divisor = zeroDecimalCurrencies.has(price.currency.toLowerCase())
    ? 1
    : 100
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(price.amount / divisor)
}
