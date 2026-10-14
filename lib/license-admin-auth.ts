import { createPublicKey, verify } from "node:crypto"
import { json, type Env } from "./cloudflare.ts"

export const LICENSE_ADMIN_EMAIL = "yogesh.patel0221@gmail.com"
const certificates = new Map<
  string,
  { expiresAt: number; keys: Record<string, unknown>[] }
>()

/** Access headers are untrusted until the JWT signature, issuer and application audience pass. */
export async function authenticateLicenseAdmin(
  request: Request,
  env: Env
): Promise<{ email: string } | Response> {
  const issuer = env.PHOTODEPOT_ACCESS_ISSUER?.replace(/\/$/, "")
  const audience = env.PHOTODEPOT_ACCESS_AUDIENCE
  if (
    !issuer ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !audience
  )
    return json({ error: "License administration is not configured." }, 503)
  const token = request.headers.get("cf-access-jwt-assertion")
  if (!token || token.length > 16384)
    return json(
      { error: "Sign in through Cloudflare Access to continue." },
      401
    )
  try {
    const parts = token.split(".")
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new Error("Malformed JWT")
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    )
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    )
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 256
    )
      throw new Error("Invalid algorithm")
    const now = Date.now()
    let cached = certificates.get(issuer)
    if (!cached || cached.expiresAt <= now) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
          redirect: "manual",
          signal: controller.signal,
        })
        if (!response.ok)
          return json(
            { error: "Admin authentication is temporarily unavailable." },
            503
          )
        const data = (await response.json()) as {
          keys?: Record<string, unknown>[]
        }
        if (!Array.isArray(data.keys) || data.keys.length > 30)
          throw new Error("Invalid certificates")
        cached = { expiresAt: now + 300_000, keys: data.keys }
        certificates.set(issuer, cached)
      } finally {
        clearTimeout(timeout)
      }
    }
    const jwk = cached.keys.find(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (key.alg === undefined || key.alg === "RS256") &&
        (key.use === undefined || key.use === "sig")
    )
    if (
      !jwk ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(parts[2], "base64url")
      )
    )
      throw new Error("Invalid signature")
    const seconds = now / 1000
    if (
      claims.iss !== issuer ||
      !(typeof claims.aud === "string"
        ? claims.aud === audience
        : Array.isArray(claims.aud) && claims.aud.includes(audience)) ||
      typeof claims.exp !== "number" ||
      claims.exp <= seconds ||
      typeof claims.iat !== "number" ||
      claims.iat > seconds + 60 ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" || claims.nbf > seconds + 60)) ||
      typeof claims.email !== "string" ||
      claims.email.toLowerCase() !== LICENSE_ADMIN_EMAIL
    )
      throw new Error("Invalid claims")
    return { email: LICENSE_ADMIN_EMAIL }
  } catch {
    return json(
      {
        error:
          "Admin authentication failed. Sign in through Cloudflare Access again.",
      },
      401
    )
  }
}
