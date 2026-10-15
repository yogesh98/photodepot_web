import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { sealData, unsealData } from "iron-session"
import {
  BodyError,
  json,
  readJson,
  readText,
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
import { validDeviceName } from "./account-device-metadata.ts"
import { allowLicenseAttempt } from "./license-rate-limit.ts"
import { bindSubscriptionDevice } from "./subscription-devices.ts"
import { getSubscription } from "./subscription-store.ts"
import { getWorkOSUser } from "./workos-users.ts"
import {
  approveDesktopSession,
  desktopSessionResponse,
  getDesktopSession,
  listAccountDevices,
  revokeDesktopSession,
} from "./account-sessions.ts"
import {
  authenticateWorkOSAccount,
  withAdminSession,
  accountAuthPage,
  accountConfigurationError,
  type AdminAuth,
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
  approved_device_revision: number | null
  account_version: number
  session_id: string | null
  intent: string
  device_name: string | null
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
      if (
        supplied.deviceName !== undefined &&
        !validDeviceName(supplied.deviceName)
      )
        return json({ error: "Invalid computer name." }, 400)
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
          ...(supplied.deviceName === undefined
            ? []
            : [supplied.deviceName as string]),
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
          "INSERT INTO account_pairings (token_hash, code_hash, device_id, public_key, challenge, created_at, expires_at, account_version, intent, device_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          hash(pairingId),
          hash(code),
          supplied.deviceId,
          supplied.devicePublicKey as string,
          supplied.challenge,
          now,
          now + lifetime,
          request.headers.get("Photodepot-Account-Version") === "1" ? 1 : 0,
          request.headers.get("Photodepot-Account-Intent") === "signup"
            ? "signup"
            : "login",
          supplied.deviceName ?? null
        ),
      ])
      return json(
        {
          pairingId,
          approvalUrl: `${origin}/account/activate?code=${code}`,
          expiresAt: now + lifetime,
          expiresInMs: lifetime,
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
      if (row.account_version === 1 && row.session_id && row.user_id)
        await revokeDesktopSession(env.DB, row.session_id, row.user_id)
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
    const deliveryNow = Date.now()
    if (row.expires_at <= deliveryNow)
      return json(
        { error: "This sign-in request expired. Start again on your Mac." },
        410
      )
    const subscription = await getSubscription(env.DB, user.id, deliveryNow)
    if (row.account_version === 1) {
      if (request.headers.get("Photodepot-Account-Version") !== "1")
        return json({ error: "Update Photodepot to finish signing in." }, 409)
      const session = row.session_id
        ? await getDesktopSession(env.DB, row.session_id)
        : null
      if (!session || session.active !== 1 || session.user_id !== user.id)
        return json(
          { error: "This Mac was logged out. Start sign-in again." },
          409
        )
      return json({
        status: "approved",
        ...(await desktopSessionResponse(env, session, row.challenge)),
      })
    }
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
        pairing: { tokenHash: row.token_hash, challenge: row.challenge },
      },
      Date.now()
    )
    if (!binding)
      return json(
        {
          error:
            "This sign-in request is no longer available, or both Mac slots are in use. Start again or remove a Mac from your account page.",
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
          ...(["2", "3"].includes(
            request.headers.get("Photodepot-Receipt-Version") ?? ""
          )
            ? { subscriptionEndsAt: binding.subscription.endsAt }
            : {}),
        },
        Date.now(),
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
const signOutForm =
  '<form method="post" action="/api/account/auth/logout"><button type="submit">Sign out</button></form><small>Using the wrong account? Sign out, then start sign-in again from Photodepot on your Mac.</small>'
function csrfToken(env: Env, auth: AdminAuth, row: Pairing, origin: string) {
  const expiresAt = Math.min(row.expires_at, Date.now() + 300_000)
  const nonce = randomBytes(32).toString("base64url")
  return `${expiresAt}.${nonce}.${csrfSignature(env, auth, row, origin, expiresAt, nonce)}`
}
function csrfSignature(
  env: Env,
  auth: AdminAuth,
  row: Pairing,
  origin: string,
  expiresAt: number,
  nonce: string
) {
  return createHmac("sha256", env.WORKOS_COOKIE_PASSWORD!)
    .update(
      JSON.stringify([
        "photodepot-desktop-sign-in-v1",
        origin,
        auth.userId,
        auth.sessionId,
        row.token_hash,
        expiresAt,
        nonce,
      ])
    )
    .digest("base64url")
}
function validCsrf(
  token: string,
  env: Env,
  auth: AdminAuth,
  row: Pairing,
  origin: string
) {
  if (!/^[0-9]{1,16}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token))
    return false
  const [expires, nonce, signature] = token.split(".")
  const expiresAt = Number(expires)
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > row.expires_at ||
    expiresAt > Date.now() + 300_000
  )
    return false
  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(csrfSignature(env, auth, row, origin, expiresAt, nonce))
  )
}
function signedInPage() {
  return page("Signed in", "<p>Return to Photodepot.</p>")
}
async function nativeSignInIntent(request: Request, env: Env, row: Pairing) {
  const origin = new URL(request.url).origin
  const secure = new URL(origin).protocol === "https:"
  const cookieName = `${secure ? "__Host-" : ""}photodepot-device-intent`
  if (request.headers.get("sec-fetch-site") === "none") {
    const value = await sealData(
      {
        version: 1,
        origin,
        pairing: row.token_hash,
        nonce: randomBytes(32).toString("base64url"),
        expiresAt: row.expires_at,
      },
      { password: env.WORKOS_COOKIE_PASSWORD!, ttl: 600 }
    )
    return {
      trusted: true,
      cookie: `${cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure ? "; Secure" : ""}`,
    }
  }
  // Redirects and hosted callbacks cannot establish trust for foreign links.
  const cookies =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`)) ?? []
  if (cookies.length === 1) {
    try {
      const value = await unsealData<{
        version?: number
        origin?: string
        pairing?: string
        nonce?: string
        expiresAt?: number
      }>(cookies[0].slice(cookieName.length + 1), {
        password: env.WORKOS_COOKIE_PASSWORD!,
        ttl: 600,
      })
      if (
        value.version === 1 &&
        value.origin === origin &&
        value.pairing === row.token_hash &&
        typeof value.nonce === "string" &&
        tokenPattern.test(value.nonce) &&
        Number.isSafeInteger(value.expiresAt) &&
        value.expiresAt! > Date.now() &&
        value.expiresAt! <= row.expires_at
      )
        return { trusted: true }
    } catch {
      /* Invalid initiation needs explicit continuation. */
    }
  }
  return { trusted: false }
}
function page(
  title: string,
  content: string,
  status = 200,
  scriptNonce?: string
) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Photodepot</title><style>body{background:#f6f4ef;color:#20231e;font:16px/1.6 system-ui;margin:0}main{max-width:460px;margin:10vh auto;padding:32px}.brand{display:block;width:220px;height:auto;margin-bottom:40px}h1{line-height:1.2;font-size:30px}button{background:#20231e;color:white;border:0;border-radius:8px;padding:14px 20px;font:inherit;cursor:pointer}small{display:block;color:#62665b;margin:20px 0}a{color:inherit}form{margin-top:24px}.computers{display:grid;gap:12px;margin:24px 0}.computer{display:flex;gap:14px;border:1px solid #d5d8d0;border-radius:12px;padding:16px;cursor:pointer}.computer input{margin-top:8px}.computer strong{display:block}.computer small{margin:4px 0 0}button:focus-visible,input:focus-visible{outline:3px solid #627b4b;outline-offset:4px}</style><main><img class="brand" src="/brand/photodepot-lockup.svg" alt="Photodepot" width="625" height="169"><h1>${title}</h1>${content}</main></html>`,
    {
      status,
      headers: {
        ...privateHeaders,
        "Content-Type": "text/html; charset=utf-8",
        // Preserve Origin on approval/sign-out forms without leaking referrers
        // to WorkOS or other external destinations.
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy": `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; ${scriptNonce ? `script-src 'nonce-${scriptNonce}'; ` : ""}form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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
    const initiation =
      row.account_version === 1 && request.method === "GET"
        ? await nativeSignInIntent(request, env, row)
        : { trusted: false }
    const rememberInitiation = (response: Response) => {
      if (initiation.cookie)
        response.headers.append("Set-Cookie", initiation.cookie)
      return response
    }
    const auth = await authenticateWorkOSAccount(request, env)
    if (auth instanceof Response) {
      if (auth.status === 401 && request.method === "GET")
        return rememberInitiation(
          new Response(null, {
            status: 302,
            headers: {
              ...privateHeaders,
              "Referrer-Policy": "no-referrer",
              Location: `/api/account/auth/login?code=${code}${row.intent === "signup" ? "&intent=signup" : ""}`,
            },
          })
        )
      return accountAuthPage(auth, `/account/activate?code=${code}`)
    }
    const respond = (response: Response) =>
      rememberInitiation(withAdminSession(response, auth))
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
          ? signedInPage()
          : page(
              "Request already used",
              "<p>This Mac sign-in request has already been approved by another account. Start again on your Mac.</p>",
              409
            )
      )
    const subscription = await getSubscription(env.DB, user.id)
    if (row.account_version === 1) {
      const origin = new URL(request.url).origin
      const target = `/account/activate?code=${code}`
      const devices = await listAccountDevices(env.DB, user.id)
      const full =
        devices.length >= 2 &&
        !devices.some((device) => device.id === row.device_id)
      const chooseComputer = (status = 200) => {
        const csrf = csrfToken(env, auth, row, origin)
        const options = devices
          .map((device, index) => {
            const name = device.deviceName ?? `Computer ${index + 1}`
            const used =
              device.lastUsedAt == null
                ? "Last used unavailable"
                : `Last used ${new Date(device.lastUsedAt).toISOString().replace("T", " ").slice(0, 16)} UTC`
            const value = escape(
              JSON.stringify({
                deviceId: device.id,
                sessionId: device.sessionId,
                revision: device.revision,
              })
            )
            const fallbackDetails = device.deviceName
              ? ""
              : `<small>Connected ${escape(new Date(device.activatedAt).toISOString().slice(0, 10))} · ID ${escape(device.id.slice(0, 12))}</small>`
            return `<label class="computer"><input type="radio" name="replacement" value="${value}" required><span><strong>${escape(name)}</strong><small>${escape(used)}</small>${fallbackDetails}</span></label>`
          })
          .join("")
        return page(
          "Choose a computer to sign out",
          `<p>Both computer slots are in use. Choose one to remove and continue signing in.</p><form method="post" action="${target}"><input type="hidden" name="csrf" value="${csrf}"><div class="computers">${options}</div><button type="submit">Remove and sign in</button></form><form method="post" action="/api/account/auth/logout"><button type="submit">Use another account</button></form>`,
          status
        )
      }
      if (request.method === "POST") {
        if (
          request.headers
            .get("content-type")
            ?.split(";")[0]
            .trim()
            .toLowerCase() !== "application/x-www-form-urlencoded"
        )
          return respond(json({ error: "Submit the sign-in form." }, 415))
        const fields = new URLSearchParams(await readText(request))
        if (
          fields.getAll("csrf").length !== 1 ||
          fields.getAll("replacement").length > 1 ||
          [...fields.keys()].some(
            (key) => !["csrf", "replacement"].includes(key)
          ) ||
          !validCsrf(fields.get("csrf") ?? "", env, auth, row, origin)
        )
          return respond(
            page(
              "Sign-in request unavailable",
              "<p>Refresh this page to continue signing in.</p>",
              403
            )
          )
        let replacement:
          | { deviceId: string; sessionId: string | null; revision: number }
          | undefined
        if (fields.has("replacement")) {
          let selected: unknown
          try {
            selected = JSON.parse(fields.get("replacement")!)
          } catch {
            return respond(
              page(
                "Choose a computer",
                "<p>Refresh this page and choose a current computer.</p>",
                400
              )
            )
          }
          if (
            !selected ||
            typeof selected !== "object" ||
            Array.isArray(selected)
          )
            return respond(
              page(
                "Choose a computer",
                "<p>Refresh this page and choose a current computer.</p>",
                400
              )
            )
          const value = selected as Record<string, unknown>
          if (
            typeof value.deviceId !== "string" ||
            !devicePattern.test(value.deviceId) ||
            (value.sessionId !== null &&
              (typeof value.sessionId !== "string" ||
                !/^[a-f0-9-]{36}$/.test(value.sessionId))) ||
            !Number.isSafeInteger(value.revision) ||
            (value.revision as number) < 1 ||
            Object.keys(value).some(
              (key) => !["deviceId", "sessionId", "revision"].includes(key)
            )
          )
            return respond(
              page(
                "Choose a computer",
                "<p>Refresh this page and choose a current computer.</p>",
                400
              )
            )
          replacement = value as typeof replacement
        }
        const approved = await approveDesktopSession(
          env.DB,
          hash(code),
          user.id,
          user.email,
          Date.now(),
          replacement
        )
        if (approved) return respond(signedInPage())
        return respond(
          page(
            "Computer list changed",
            `<p>No computer was removed. <a href="${target}">Refresh and continue signing in</a>.</p>`,
            409
          )
        )
      }
      if (full) return respond(chooseComputer())
      const csrf = csrfToken(env, auth, row, origin)
      if (!initiation.trusted)
        return respond(
          page(
            "Continue signing in",
            `<p>Sign in on <strong>${escape(row.device_name ?? "this computer")}</strong> as ${escape(user.email)}.</p><form method="post" action="${target}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Continue</button></form>`
          )
        )
      const nonce = randomBytes(18).toString("base64url")
      return respond(
        page(
          "Signing in…",
          `<p aria-live="polite">Finishing your sign-in.</p><form id="continue-sign-in" method="post" action="${target}"><input type="hidden" name="csrf" value="${csrf}"><noscript><button type="submit">Continue</button></noscript></form><script nonce="${nonce}">document.getElementById('continue-sign-in').requestSubmit()</script>`,
          200,
          nonce
        )
      )
    }
    if (subscription?.status !== "active")
      return respond(
        page(
          "Subscription required",
          `<p>Signed in as <strong>${escape(user.email)}</strong>.</p><p>Your account ${subscription?.status === "expired" ? "subscription has expired" : subscription?.status === "revoked" ? "subscription has been revoked" : "does not have a subscription yet"}. Ask the Photodepot Owner to assign or renew your access, then refresh this page.</p><p><a href="/account">Open your account page</a> to review your subscription or request access.</p>${signOutForm}`,
          403
        )
      )
    if (
      subscription.devices.length >= subscription.deviceLimit &&
      !subscription.devices.some((device) => device.id === row.device_id)
    )
      return respond(
        page(
          "Mac limit reached",
          `<p>Signed in as <strong>${escape(user.email)}</strong>.</p><p>Your account already has ${subscription.deviceLimit} connected Macs.</p><p><a href="/account">Open your account page</a> to remove a Mac before connecting another Mac.</p>${signOutForm}`,
          409
        )
      )
    if (request.method === "POST") {
      const result = await env.DB.prepare(
        "UPDATE account_pairings SET status = 'approved', user_id = ?, approved_binding_revision = (SELECT binding_revision FROM subscriptions WHERE user_id = ?), approved_device_revision = COALESCE((SELECT assignment_revision FROM account_devices WHERE device_id = ?), 1) WHERE code_hash = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM subscriptions WHERE user_id = ? AND status = 'active' AND started_at <= ? AND end_at > ?) RETURNING token_hash"
      )
        .bind(
          user.id,
          user.id,
          row.device_id,
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
      return respond(signedInPage())
    }
    return respond(
      page(
        "Sign in on your Mac",
        `<p>Signed in as <strong>${escape(user.email)}</strong>.</p><p>${subscription.type === "trial" ? "Trial" : "Standard"} subscription active until ${escape(new Date(subscription.endsAt).toISOString().slice(0, 10))}.</p><small>Only approve if you just clicked Sign in in Photodepot on your own Mac. This connects this Mac to your account (${subscription.devices.length} of ${subscription.deviceLimit} slots currently used).<br>Mac fingerprint: ${escape(row.device_id.slice(0, 12))}</small><form method="post" action="/account/activate?code=${code}"><button type="submit">Approve Mac sign-in</button></form>${signOutForm}`
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
