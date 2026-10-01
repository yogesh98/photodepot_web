import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export type Architecture = "arm64" | "x64"
export const ACCESS_SECONDS = 300
export const ACCESS_COOKIE = "photodepot-download"

export function isArchitecture(value: string): value is Architecture {
  return value === "arm64" || value === "x64"
}

export function passwordsMatch(supplied: string, expected: string) {
  if (!expected || !supplied || supplied.length > 1024) return false
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest()
  )
}

function signature(payload: string, password: string) {
  return createHmac("sha256", password)
    .update(`photodepot-download:${payload}`)
    .digest("hex")
}

export function createAccessToken(
  architecture: Architecture,
  password: string,
  now = Date.now()
) {
  const payload = `${architecture}.${Math.floor(now / 1000) + ACCESS_SECONDS}`
  return `${payload}.${signature(payload, password)}`
}

export function hasDownloadAccess(
  token: string | undefined,
  architecture: Architecture,
  password: string,
  now = Date.now()
) {
  if (!token || !password) return false
  const parts = token.split(".")
  if (parts.length !== 3) return false
  const [build, expiration, mac] = parts
  const expires = Number(expiration)
  const seconds = Math.floor(now / 1000)
  if (
    build !== architecture ||
    !Number.isSafeInteger(expires) ||
    expires <= seconds ||
    expires > seconds + ACCESS_SECONDS ||
    !/^[a-f0-9]{64}$/.test(mac)
  )
    return false
  return timingSafeEqual(
    Buffer.from(mac, "hex"),
    Buffer.from(signature(`${build}.${expiration}`, password), "hex")
  )
}

// Per-process protection. Use a shared hosting-edge limit for multiple instances;
// forwarded IP headers must come from a trusted proxy.
const attempts = new Map<string, { count: number; expires: number }>()
export function allowPasswordAttempt(key: string, now = Date.now()) {
  for (const [ip, record] of attempts) {
    if (record.expires <= now) attempts.delete(ip)
  }
  const record = attempts.get(key)
  if (record) {
    if (record.count >= 8) return false
    record.count += 1
  } else {
    if (attempts.size >= 10_000) return false
    attempts.set(key, { count: 1, expires: now + 10 * 60 * 1000 })
  }
  return true
}
