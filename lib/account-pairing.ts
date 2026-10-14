import { createHash, randomBytes } from "node:crypto"
import {
  BodyError,
  json,
  readJson,
  sameOrigin,
  privateHeaders,
  type Env,
} from "./cloudflare.ts"
import {
  CHALLENGE_PATTERN,
  parseDevicePublicKey,
  validDeviceProof,
  signingKey,
  signedReceipt,
} from "./license-crypto.ts"
import { allowLicenseAttempt } from "./license-rate-limit.ts"
import { bindSubscriptionDevice } from "./subscription-devices.ts"
import { getSubscription } from "./subscription-store.ts"
import { getWorkOSUser } from "./workos-users.ts"
import {
  authenticateWorkOSAccount,
  withAdminSession,
  accountAuthPage,
  accountConfigurationError,
} from "./license-admin-auth.ts"

const lifetime = 600_000
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const devicePattern = /^[a-f0-9]{64}$/
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
interface Pairing {
  token_hash: string
  code_hash: string
  device_id: string
  public_key: string
  challenge: string
  status: "pending" | "approved" | "cancelled"
  user_id: string | null
  approved_binding_revision: number | null
  created_at: number
  expires_at: number
}
function canonicalOrigin(request: Request, env: Env) {
  if (!env.WORKOS_REDIRECT_URI)
    throw new Error("Account sign-in is not configured")
  const callback = new URL(env.WORKOS_REDIRECT_URI)
  const local =
    callback.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(callback.hostname)
  if (
    (callback.protocol !== "https:" && !local) ||
    callback.pathname !== "/api/auth/callback" ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    throw new Error("Invalid account configuration")
  return new URL(request.url).origin === callback.origin
    ? callback.origin
    : null
}
function method(allowed: string) {
  const response = json({ error: "Method not allowed." }, 405)
  response.headers.set("Allow", allowed)
  return response
}
export async function handleAccountPairing(
  request: Request,
  env: Env,
  action: "start" | "poll" | "cancel"
) {
  if (request.method !== "POST") return method("POST")
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Submit JSON." }, 415)
  try {
    const origin = canonicalOrigin(request, env)
    if (!origin)
      return json(
        { error: "Account sign-in is unavailable on this hostname." },
        403
      )
    const signer = signingKey(env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY)
    const body = await readJson(request)
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json({ error: "Invalid request." }, 400)
    const supplied = body as Record<string, unknown>
    if (
      typeof supplied.deviceId !== "string" ||
      !devicePattern.test(supplied.deviceId) ||
      typeof supplied.challenge !== "string" ||
      !CHALLENGE_PATTERN.test(supplied.challenge)
    )
      return json({ error: "Invalid Mac sign-in request." }, 400)
    const allowed = await allowLicenseAttempt(
      env.DB,
      `account-${action}`,
      request.headers.get("cf-connecting-ip") ?? "unknown",
      env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY!,
      action === "start" ? 12 : 120,
      action === "start" ? lifetime : 60_000
    )
    if (!allowed) {
      const response = json(
        { error: "Too many requests. Try again shortly." },
        429
      )
      response.headers.set("Retry-After", action === "start" ? "600" : "60")
      return response
    }
    const now = Date.now()
    if (action === "start") {
      const configurationError = accountConfigurationError(request, env)
      if (configurationError) return configurationError
      let device
      try {
        device = parseDevicePublicKey(supplied.devicePublicKey)
      } catch {
        return json({ error: "Invalid device key." }, 400)
      }
      if (
        device.deviceId !== supplied.deviceId ||
        !validDeviceProof(device.key, supplied.deviceSignature, [
          "photodepot-account-pairing-v1",
          "start",
          supplied.deviceId,
          supplied.devicePublicKey as string,
          supplied.challenge,
        ])
      )
        return json({ error: "Mac verification failed." }, 401)
      // Check configuration before offering a browser flow that cannot complete.
      if (!env.WORKOS_API_KEY)
        throw new Error("WorkOS user management not configured")
      const pairingId = randomBytes(32).toString("base64url")
      const code = randomBytes(32).toString("base64url")
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM account_pairings WHERE token_hash IN (SELECT token_hash FROM account_pairings WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)"
        ).bind(now),
        env.DB.prepare(
          "UPDATE account_pairings SET status = 'cancelled' WHERE device_id = ? AND status = 'pending'"
        ).bind(supplied.deviceId),
        env.DB.prepare(
          "INSERT INTO account_pairings (token_hash, code_hash, device_id, public_key, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          hash(pairingId),
          hash(code),
          supplied.deviceId,
          supplied.devicePublicKey as string,
          supplied.challenge,
          now,
          now + lifetime
        ),
      ])
      return json(
        {
          pairingId,
          approvalUrl: `${origin}/account/activate?code=${code}`,
          expiresAt: now + lifetime,
          pollIntervalMs: 2000,
        },
        201
      )
    }
    if (
      typeof supplied.pairingId !== "string" ||
      !tokenPattern.test(supplied.pairingId)
    )
      return json({ error: "Invalid sign-in request." }, 400)
    const row = await env.DB.prepare(
      "SELECT * FROM account_pairings WHERE token_hash = ?"
    )
      .bind(hash(supplied.pairingId))
      .first<Pairing>()
    if (!row || row.expires_at <= now || row.status === "cancelled")
      return json(
        {
          error:
            "This sign-in request expired or was cancelled. Start again on your Mac.",
        },
        410
      )
    const device = parseDevicePublicKey(row.public_key)
    if (
      row.device_id !== supplied.deviceId ||
      device.deviceId !== supplied.deviceId ||
      row.challenge !== supplied.challenge ||
      !validDeviceProof(device.key, supplied.deviceSignature, [
        "photodepot-account-pairing-v1",
        action,
        supplied.pairingId,
        supplied.deviceId,
        supplied.challenge,
      ])
    )
      return json({ error: "Mac verification failed." }, 401)
    if (action === "cancel") {
      await env.DB.prepare(
        "UPDATE account_pairings SET status = 'cancelled' WHERE token_hash = ?"
      )
        .bind(row.token_hash)
        .run()
      return json({ status: "cancelled" })
    }
    if (row.status === "pending") return json({ status: "pending" })
    const user = await getWorkOSUser(env, row.user_id!)
    if (!user?.emailVerified)
      return json({ error: "This account is unavailable. Sign in again." }, 403)
    const subscription = await getSubscription(env.DB, user.id, now)
    if (subscription?.status !== "active")
      return json(
        {
          error:
            "Your account has no active subscription. Contact Photodepot for access.",
        },
        403
      )
    const binding = await bindSubscriptionDevice(
      env.DB,
      {
        userId: user.id,
        deviceId: row.device_id,
        publicKey: row.public_key,
        expectedBindingRevision: row.approved_binding_revision!,
      },
      now
    )
    if (!binding)
      return json(
        {
          error:
            "Your subscription is assigned to another Mac. Ask the Owner to reset your Mac access.",
        },
        409
      )
    // Delivery is retryable to this exact device and challenge until expiry.
    // The account approval is immutable, and every delivery checks current access.
    return json({
      status: "approved",
      receipt: signedReceipt(
        signer,
        {
          licenseId: binding.subscription.id,
          deviceId: row.device_id,
          type: binding.subscription.type,
          status: "active",
          challenge: row.challenge,
          revision: binding.subscription.revision,
        },
        now,
        binding.subscription.endsAt
      ),
    })
  } catch (error) {
    if (error instanceof BodyError)
      return json({ error: "Invalid request." }, error.status)
    console.error("Account sign-in service unavailable")
    return json(
      {
        error: "Account sign-in is temporarily unavailable. Please try again.",
      },
      503
    )
  }
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!
  )
function page(title: string, content: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Photodepot</title><style>body{background:#f6f4ef;color:#20231e;font:16px/1.6 system-ui;margin:0}main{max-width:460px;margin:10vh auto;padding:32px}h1{line-height:1.2;font-size:30px}button{background:#20231e;color:white;border:0;border-radius:8px;padding:14px 20px;font:inherit;cursor:pointer}small{display:block;color:#62665b;margin:20px 0}a{color:inherit}form{margin-top:24px}</style><main><p>photodepot</p><h1>${title}</h1>${content}</main></html>`,
    {
      status,
      headers: {
        ...privateHeaders,
        "Content-Type": "text/html; charset=utf-8",
        // Preserve Origin on approval/sign-out forms without leaking referrers
        // to WorkOS or other external destinations.
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    }
  )
}
export async function handleAccountApproval(request: Request, env: Env) {
  if (!["GET", "POST"].includes(request.method)) return method("GET, POST")
  if (request.method === "POST" && !sameOrigin(request))
    return json({ error: "Invalid request origin." }, 403)
  try {
    if (!canonicalOrigin(request, env))
      return page(
        "Sign-in unavailable",
        "<p>Open sign-in from Photodepot on your Mac.</p>",
        403
      )
    const code = new URL(request.url).searchParams.get("code") ?? ""
    if (!tokenPattern.test(code))
      return page(
        "Invalid sign-in request",
        "<p>Start sign-in again in Photodepot on your Mac.</p>",
        400
      )
    const row = await env.DB.prepare(
      "SELECT * FROM account_pairings WHERE code_hash = ?"
    )
      .bind(hash(code))
      .first<Pairing>()
    if (!row || row.expires_at <= Date.now() || row.status === "cancelled")
      return page(
        "Sign-in request expired",
        "<p>Start sign-in again in Photodepot on your Mac.</p>",
        410
      )
    const auth = await authenticateWorkOSAccount(request, env)
    if (auth instanceof Response) {
      if (auth.status === 401 && request.method === "GET")
        return new Response(null, {
          status: 302,
          headers: {
            ...privateHeaders,
            "Referrer-Policy": "no-referrer",
            Location: `/api/account/auth/login?code=${code}`,
          },
        })
      return accountAuthPage(auth)
    }
    const respond = (response: Response) => withAdminSession(response, auth)
    const user = await getWorkOSUser(env, auth.userId)
    if (!user?.emailVerified)
      return respond(
        page(
          "Account unavailable",
          "<p>Return to Photodepot on your Mac and start sign-in again.</p>",
          403
        )
      )
    if (row.status === "approved")
      return respond(
        row.user_id === user.id
          ? page(
              "Mac sign-in approved",
              "<p>You can return to Photodepot on your Mac. The app will finish signing in automatically.</p>"
            )
          : page(
              "Request already used",
              "<p>This Mac sign-in request has already been approved by another account. Start again on your Mac.</p>",
              409
            )
      )
    const subscription = await getSubscription(env.DB, user.id)
    if (subscription?.status !== "active")
      return respond(
        page(
          "Subscription required",
          `<p>Signed in as <strong>${escape(user.email)}</strong>.</p><p>Your account ${subscription?.status === "expired" ? "subscription has expired" : subscription?.status === "revoked" ? "subscription has been revoked" : "does not have a subscription yet"}. Ask the Photodepot Owner to assign or renew your access, then refresh this page.</p>`,
          403
        )
      )
    if (request.method === "POST") {
      const result = await env.DB.prepare(
        "UPDATE account_pairings SET status = 'approved', user_id = ?, approved_binding_revision = (SELECT binding_revision FROM subscriptions WHERE user_id = ?) WHERE code_hash = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM subscriptions WHERE user_id = ? AND status = 'active' AND started_at <= ? AND end_at > ?) RETURNING token_hash"
      )
        .bind(
          user.id,
          user.id,
          hash(code),
          Date.now(),
          user.id,
          Date.now(),
          Date.now()
        )
        .first()
      if (!result)
        return respond(
          page(
            "Request already used or expired",
            "<p>Start sign-in again on your Mac.</p>",
            409
          )
        )
      return respond(
        page(
          "Mac sign-in approved",
          "<p>You can return to Photodepot on your Mac. The app will finish signing in automatically.</p>"
        )
      )
    }
    return respond(
      page(
        "Sign in on your Mac",
        `<p>Signed in as <strong>${escape(user.email)}</strong>.</p><p>${subscription.type === "trial" ? "Trial" : "Standard"} subscription active until ${escape(new Date(subscription.endsAt).toISOString().slice(0, 10))}.</p><small>Only approve if you just clicked Sign in in Photodepot on your own Mac. This links your subscription to that Mac.<br>Mac fingerprint: ${escape(row.device_id.slice(0, 12))}</small><form method="post" action="/account/activate?code=${code}"><button type="submit">Approve Mac sign-in</button></form><form method="post" action="/api/account/auth/logout"><button type="submit">Sign out</button></form>`
      )
    )
  } catch {
    console.error("Account approval service unavailable")
    return page(
      "Sign-in temporarily unavailable",
      "<p>Please try again in a moment.</p>",
      503
    )
  }
}
