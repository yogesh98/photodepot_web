import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"

export const LICENSE_GRACE_MS = 48 * 60 * 60 * 1000
export const LICENSE_KEY_PATTERN = /^PD-(?:[A-F0-9]{8}-){5}[A-F0-9]{8}$/
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const publicKeys = new Map<string, KeyObject>()
let cachedSigningKey: { source: string; key: KeyObject } | undefined

export function signingKey(source: string | undefined) {
  if (!source) throw new Error("License signing is not configured")
  if (cachedSigningKey?.source === source) return cachedSigningKey.key
  const key = createPrivateKey({
    key: Buffer.from(source, "base64"),
    format: "der",
    type: "pkcs8",
  })
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Invalid signing key")
  cachedSigningKey = { source, key }
  return key
}
export function normalizeLicenseKey(key: string) {
  return key.trim().toUpperCase()
}
export function hashLicenseKey(key: string) {
  return createHash("sha256").update(normalizeLicenseKey(key)).digest("hex")
}
export function generateLicenseKey() {
  return `PD-${randomBytes(24).toString("hex").toUpperCase().match(/.{8}/g)!.join("-")}`
}
export function parseDevicePublicKey(encoded: unknown) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(encoded))
    throw new Error("Invalid device key")
  const bytes = Buffer.from(encoded, "base64url")
  if (bytes.toString("base64url") !== encoded)
    throw new Error("Invalid device key")
  let key = publicKeys.get(encoded)
  if (!key) {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" })
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("Invalid device key")
    if (publicKeys.size >= 100) publicKeys.clear()
    publicKeys.set(encoded, key)
  }
  return { key, deviceId: createHash("sha256").update(bytes).digest("hex") }
}
export function validDeviceProof(
  key: KeyObject,
  proof: unknown,
  parts: string[]
) {
  return (
    typeof proof === "string" &&
    /^[A-Za-z0-9_-]{86}$/.test(proof) &&
    verify(
      null,
      Buffer.from(JSON.stringify(parts)),
      key,
      Buffer.from(proof, "base64url")
    )
  )
}
export function signedReceipt(
  key: KeyObject,
  details: {
    licenseId: string
    deviceId: string
    type: "trial" | "regular"
    status: "active" | "revoked"
    challenge: string
    revision: number
  },
  now = Date.now(),
  maxExpiresAt?: number
) {
  const expiresAt =
    details.status === "active" && maxExpiresAt !== undefined
      ? Math.min(now + LICENSE_GRACE_MS, maxExpiresAt)
      : now + LICENSE_GRACE_MS
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
    throw new Error("License access has expired")
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      ...details,
      issuedAt: now,
      expiresAt,
    })
  ).toString("base64url")
  return {
    payload,
    signature: sign(null, Buffer.from(payload, "base64url"), key).toString(
      "base64url"
    ),
  }
}
