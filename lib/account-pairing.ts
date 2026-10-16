import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
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
} from "./license-crypto.ts"
import { updateRequired } from "./license-api.ts"
import { validDeviceName } from "./account-device-metadata.ts"
import { allowLicenseAttempt } from "./license-rate-limit.ts"
import { getWorkOSUser } from "./workos-users.ts"
import {
  approveDesktopSession,
  cancelAccountPairing,
  desktopSessionResponse,
  getDesktopSession,
  listAccountDevices,
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
  if (request.headers.get("Photodepot-Account-Version") !== "1")
    return updateRequired()
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
    signingKey(env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY)
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
        // Keep an active session's pairing so its Mac can cancel even after
        // the delivery deadline. Revoked sessions no longer need this link.
        env.DB.prepare(
          `DELETE FROM account_pairings WHERE token_hash IN (
            SELECT p.token_hash FROM account_pairings p WHERE p.expires_at <= ?
            AND NOT EXISTS (SELECT 1 FROM desktop_sessions s WHERE s.id = p.session_id AND s.active = 1)
            ORDER BY p.expires_at LIMIT 100)`
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
          1,
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
    if (
      !row ||
      (action !== "cancel" && row.expires_at <= now) ||
      row.status === "cancelled"
    )
      return json(
        {
          error:
            "This sign-in request expired or was cancelled. Start again on your Mac.",
        },
        410
      )
    if (row.account_version !== 1) return updateRequired()
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
      await cancelAccountPairing(env.DB, row.token_hash)
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
    const session = row.session_id
      ? await getDesktopSession(env.DB, row.session_id)
      : null
    if (!session || session.active !== 1 || session.user_id !== user.id)
      return json(
        { error: "This computer was logged out. Start sign-in again." },
        409
      )
    return json({
      status: "approved",
      ...(await desktopSessionResponse(env, session, row.challenge)),
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
function page(title: string, content: string, status = 200) {
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
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    if (row.account_version !== 1)
      return page(
        "Update Photodepot",
        "<p>Update Photodepot and start sign-in again on your computer.</p>",
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
            Location: `/api/account/auth/login?code=${code}${row.intent === "signup" ? "&intent=signup" : ""}`,
          },
        })
      return accountAuthPage(auth, `/account/activate?code=${code}`)
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
          ? signedInPage()
          : page(
              "Request already used",
              "<p>This Mac sign-in request has already been approved by another account. Start again on your Mac.</p>",
              409
            )
      )
    {
      const origin = new URL(request.url).origin
      const target = `/account/activate?code=${code}`
      const devices = await listAccountDevices(env.DB, user.id)
      const full =
        devices.length >= 2 &&
        !devices.some((device) => device.id === row.device_id)
      const consent = `<p>Sign in on <strong>${escape(row.device_name ?? "this computer")}</strong> as ${escape(user.email)}.</p><p>Only approve if you just started sign-in in Photodepot on your own computer.</p>`
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
          `${consent}<p>Both computer slots are in use. Choose one to remove and continue signing in.</p><form method="post" action="${target}"><input type="hidden" name="csrf" value="${csrf}"><div class="computers">${options}</div><button type="submit">Remove and sign in</button></form><form method="post" action="/api/account/auth/logout"><button type="submit">Use another account</button></form>`,
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
          { deviceId: string; sessionId: string; revision: number } | undefined
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
            typeof value.sessionId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(value.sessionId) ||
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
      return respond(
        page(
          "Continue signing in",
          `${consent}<form method="post" action="${target}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Approve computer sign-in</button></form>${signOutForm}`
        )
      )
    }
  } catch {
    console.error("Account approval service unavailable")
    return page(
      "Sign-in temporarily unavailable",
      "<p>Please try again in a moment.</p>",
      503
    )
  }
}
