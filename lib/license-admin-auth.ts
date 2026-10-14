import { createWorkOS } from "@workos-inc/node"
import { sealData, unsealData } from "iron-session"
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose"
import { json, privateHeaders, sameOrigin, type Env } from "./cloudflare.ts"

const sessionLifetime = 7 * 24 * 60 * 60
const loginLifetime = 10 * 60
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export interface AdminSession {
  version: 1
  audience?: "admin" | "account"
  clientId: string
  origin: string
  accessToken: string
  refreshToken: string
  user: { id: string; email: string; emailVerified: boolean }
}
export interface AdminAuth {
  email: string
  userId: string
  sessionId: string
  setCookie?: string
}
interface LoginTransaction {
  clientId: string
  origin: string
  state: string
  codeVerifier: string
  audience?: "admin" | "account"
  returnPath?: string
}
function configuration(
  request: Request,
  env: Env,
  audience: "admin" | "account" = "admin"
) {
  const clientId = env.WORKOS_CLIENT_ID
  const organizationId = env.WORKOS_ADMIN_ORGANIZATION_ID
  const password = env.WORKOS_COOKIE_PASSWORD
  const redirectUri = env.WORKOS_REDIRECT_URI
  if (
    !clientId ||
    !/^client_[a-zA-Z0-9_]+$/.test(clientId) ||
    !organizationId ||
    !/^org_[a-zA-Z0-9_]+$/.test(organizationId) ||
    !password ||
    password.length < 32 ||
    !redirectUri
  )
    return json({ error: "License administration is not configured." }, 503)
  try {
    const callback = new URL(redirectUri)
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
      throw new Error("Invalid callback")
    if (new URL(request.url).origin !== callback.origin)
      return json(
        { error: "Administration is unavailable on this hostname." },
        403
      )
    return {
      clientId,
      organizationId,
      password,
      redirectUri,
      origin: callback.origin,
      secure: !local,
      audience,
      workos: createWorkOS({ clientId, timeout: 5000, maxRetries: 0 }),
    }
  } catch {
    return json({ error: "License administration is not configured." }, 503)
  }
}
type Configuration = Exclude<ReturnType<typeof configuration>, Response>
export function accountConfigurationError(
  request: Request,
  env: Env
): Response | undefined {
  const config = configuration(request, env, "account")
  return config instanceof Response ? config : undefined
}
function cookieName(config: Configuration, login = false) {
  const suffix =
    config.audience === "account"
      ? login
        ? "account-login"
        : "account"
      : login
        ? "login"
        : "admin"
  return `${config.secure ? "__Host-" : ""}photodepot-${suffix}`
}
function cookie(request: Request, name: string): string | undefined {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  if (matches.length !== 1) return undefined
  const value = matches[0].slice(name.length + 1)
  return value.length <= 3800 ? value : undefined
}
function setCookie(config: Configuration, value: string, login = false) {
  if (value.length > 3800) throw new Error("Session is too large")
  return `${cookieName(config, login)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? (login ? loginLifetime : sessionLifetime) : 0}${config.secure ? "; Secure" : ""}`
}
function redirect(location: string, status = 302) {
  return new Response(null, {
    status,
    headers: {
      ...privateHeaders,
      Location: location,
      "Referrer-Policy": "no-referrer",
    },
  })
}
function unauthenticated() {
  return json({ error: "Sign in to Photodepot to continue." }, 401)
}
function unavailable() {
  return json(
    { error: "Sign-in is temporarily unavailable. Please try again." },
    503
  )
}
function denied() {
  return json(
    { error: "The Owner role in Photodepot Administration is required." },
    403
  )
}
function authenticationFailure(error: unknown) {
  return (
    error instanceof errors.JOSEError &&
    [
      "ERR_JWT_EXPIRED",
      "ERR_JWT_CLAIM_VALIDATION_FAILED",
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      "ERR_JWS_INVALID",
      "ERR_JWT_INVALID",
      "ERR_JOSE_ALG_NOT_ALLOWED",
      "ERR_JWKS_NO_MATCHING_KEY",
    ].includes(error.code)
  )
}
async function accessClaims(
  accessToken: string,
  config: Configuration
): Promise<JWTPayload> {
  let keys = jwks.get(config.clientId)
  if (!keys) {
    keys = createRemoteJWKSet(
      new URL(config.workos.userManagement.getJwksUrl(config.clientId)),
      {
        timeoutDuration: 5000,
        [customFetch]: (input, init) =>
          fetch(input, { ...init, redirect: "manual" }),
      }
    )
    jwks.set(config.clientId, keys)
  }
  const { payload } = await jwtVerify(accessToken, keys, {
    algorithms: ["RS256"],
    issuer: [
      "https://api.workos.com",
      "https://api.workos.com/",
      `https://api.workos.com/user_management/${config.clientId}`,
    ],
    requiredClaims: ["sub", "sid", "client_id", "exp", "iat"],
  })
  if (
    payload.client_id !== config.clientId ||
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.iat !== "number" ||
    payload.iat > Date.now() / 1000 + 60
  )
    throw new errors.JWTClaimValidationFailed(
      "Invalid session claims",
      payload,
      "client_id"
    )
  return payload
}
function owner(
  claims: JWTPayload,
  session: AdminSession,
  config: Configuration
): AdminAuth | Response {
  if (claims.sub !== session.user.id || !session.user.emailVerified)
    return unauthenticated()
  if (
    claims.org_id !== config.organizationId ||
    !(
      claims.role === "owner" ||
      (Array.isArray(claims.roles) && claims.roles.includes("owner"))
    )
  )
    return denied()
  return {
    email: session.user.email,
    userId: session.user.id,
    sessionId: claims.sid as string,
  }
}
function account(
  claims: JWTPayload,
  session: AdminSession
): AdminAuth | Response {
  if (claims.sub !== session.user.id || !session.user.emailVerified)
    return unauthenticated()
  return {
    email: session.user.email,
    userId: session.user.id,
    sessionId: claims.sid as string,
  }
}
async function readSession(
  request: Request,
  config: Configuration
): Promise<AdminSession | undefined> {
  const value = cookie(request, cookieName(config))
  if (!value) return undefined
  try {
    const data = await unsealData<AdminSession>(value, {
      password: config.password,
      ttl: sessionLifetime,
    })
    if (
      data.version !== 1 ||
      (data.audience ?? "admin") !== config.audience ||
      data.clientId !== config.clientId ||
      data.origin !== config.origin ||
      typeof data.accessToken !== "string" ||
      data.accessToken.length > 16000 ||
      typeof data.refreshToken !== "string" ||
      data.refreshToken.length > 4000 ||
      typeof data.user?.id !== "string" ||
      typeof data.user.email !== "string" ||
      typeof data.user.emailVerified !== "boolean"
    )
      return undefined
    return data
  } catch {
    return undefined
  }
}
async function saveSession(config: Configuration, session: AdminSession) {
  return setCookie(
    config,
    await sealData(session, { password: config.password, ttl: sessionLifetime })
  )
}
/** WorkOS-signed Owner memberships in the configured organization authorize administration. */
export async function authenticateLicenseAdmin(
  request: Request,
  env: Env
): Promise<AdminAuth | Response> {
  return authenticateSession(request, env, "admin")
}
export async function authenticateWorkOSAccount(
  request: Request,
  env: Env
): Promise<AdminAuth | Response> {
  return authenticateSession(request, env, "account")
}
async function authenticateSession(
  request: Request,
  env: Env,
  audience: "admin" | "account"
): Promise<AdminAuth | Response> {
  const config = configuration(request, env, audience)
  if (config instanceof Response) return config
  let session = await readSession(request, config)
  if (!session) return unauthenticated()
  try {
    const claims = await accessClaims(session.accessToken, config)
    return audience === "admin"
      ? owner(claims, session, config)
      : account(claims, session)
  } catch (error) {
    if (!(error instanceof errors.JWTExpired))
      return authenticationFailure(error) ? unauthenticated() : unavailable()
  }
  try {
    const refreshed =
      await config.workos.userManagement.authenticateWithRefreshToken({
        refreshToken: session.refreshToken,
        ...(audience === "admin"
          ? { organizationId: config.organizationId }
          : {}),
      })
    session = {
      ...session,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      user: {
        id: refreshed.user.id,
        email: refreshed.user.email,
        emailVerified: refreshed.user.emailVerified,
      },
    }
    const claims = await accessClaims(session.accessToken, config)
    const result =
      audience === "admin"
        ? owner(claims, session, config)
        : account(claims, session)
    if (result instanceof Response) return result
    return { ...result, setCookie: await saveSession(config, session) }
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : undefined
    // Preserve cookies during outages. An expired access token never authorizes a request.
    return (typeof status === "number" && [400, 401, 403].includes(status)) ||
      authenticationFailure(error)
      ? unauthenticated()
      : unavailable()
  }
}
export function withAdminSession(response: Response, auth: AdminAuth) {
  if (auth.setCookie) response.headers.append("Set-Cookie", auth.setCookie)
  return response
}
export function adminAuthPage(response: Response) {
  const title =
    response.status === 403
      ? "Owner access required"
      : response.status === 503
        ? "Sign-in is temporarily unavailable"
        : "Sign in again"
  const message =
    response.status === 403
      ? "This account needs the Owner role in Photodepot Administration. Ask the account owner to update your access, then sign in again."
      : response.status === 503
        ? "Please try again in a moment."
        : "Your sign-in expired or could not be completed. Start sign-in again to continue."
  const headers = new Headers(response.headers)
  headers.set("Content-Type", "text/html; charset=utf-8")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  )
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Photodepot</title><style>body{margin:0;background:#f6f4ef;color:#20231e;font:16px/1.6 system-ui,sans-serif}main{max-width:440px;margin:12vh auto;padding:32px}h1{font-size:28px;line-height:1.2}a{color:inherit}nav{display:flex;gap:24px;margin-top:28px}</style><main><p>photodepot</p><h1>${title}</h1><p>${message}</p><nav><a href="/api/auth/login">Sign in</a><a href="/">Back to Photodepot</a></nav></main></html>`,
    { status: response.status, headers }
  )
}
export async function handleAdminLogin(request: Request, env: Env) {
  return beginLogin(request, env, "admin")
}
export async function handleAccountLogin(request: Request, env: Env) {
  if (request.method !== "GET") return methodNotAllowed("GET")
  const code = new URL(request.url).searchParams.get("code")
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code))
    return json({ error: "Invalid Mac sign-in request." }, 400)
  return beginLogin(request, env, "account", `/account/activate?code=${code}`)
}
async function beginLogin(
  request: Request,
  env: Env,
  audience: "admin" | "account",
  returnPath?: string
) {
  if (request.method !== "GET") return methodNotAllowed("GET")
  const config = configuration(request, env, audience)
  if (config instanceof Response) return config
  const { url, state, codeVerifier } =
    await config.workos.userManagement.getAuthorizationUrlWithPKCE({
      provider: "authkit",
      redirectUri: config.redirectUri,
      ...(audience === "admin"
        ? { organizationId: config.organizationId }
        : {}),
      screenHint: "sign-in",
    })
  const transaction: LoginTransaction = {
    clientId: config.clientId,
    origin: config.origin,
    state,
    codeVerifier,
    audience,
    returnPath,
  }
  const response = redirect(url)
  response.headers.append(
    "Set-Cookie",
    setCookie(
      config,
      await sealData(transaction, {
        password: config.password,
        ttl: loginLifetime,
      }),
      true
    )
  )
  return response
}
export async function handleAdminCallback(request: Request, env: Env) {
  if (request.method !== "GET") return methodNotAllowed("GET")
  let config = configuration(request, env)
  if (config instanceof Response) return config
  const query = new URL(request.url).searchParams
  let response: Response
  try {
    let transaction: LoginTransaction | undefined
    for (const audience of ["admin", "account"] as const) {
      const candidateConfig = { ...config, audience }
      const value = cookie(request, cookieName(candidateConfig, true))
      if (!value) continue
      const candidate = await unsealData<LoginTransaction>(value, {
        password: config.password,
        ttl: loginLifetime,
      })
      if (
        candidate.state === query.get("state") &&
        (candidate.audience ?? "admin") === audience
      ) {
        transaction = candidate
        config = candidateConfig
        break
      }
    }
    if (
      !transaction?.state ||
      transaction.state !== query.get("state") ||
      transaction.clientId !== config.clientId ||
      transaction.origin !== config.origin ||
      !transaction.codeVerifier ||
      (config.audience === "account" &&
        !/^\/account\/activate\?code=[A-Za-z0-9_-]{43}$/.test(
          transaction.returnPath ?? ""
        )) ||
      query.has("error") ||
      !query.get("code") ||
      query.get("code")!.length > 2000
    ) {
      response = json(
        {
          error:
            "Sign-in expired or could not be verified. Start sign-in again.",
        },
        401
      )
    } else {
      const result =
        await config.workos.userManagement.authenticateWithCodeAndVerifier({
          code: query.get("code")!,
          codeVerifier: transaction.codeVerifier,
        })
      const session: AdminSession = {
        version: 1,
        audience: config.audience,
        clientId: config.clientId,
        origin: config.origin,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: {
          id: result.user.id,
          email: result.user.email,
          emailVerified: result.user.emailVerified,
        },
      }
      const claims = await accessClaims(session.accessToken, config)
      const auth =
        config.audience === "admin"
          ? owner(claims, session, config)
          : account(claims, session)
      if (auth instanceof Response) {
        response = auth
        response.headers.append("Set-Cookie", setCookie(config, ""))
      } else {
        if (
          config.audience === "account" &&
          !/^\/account\/activate\?code=[A-Za-z0-9_-]{43}$/.test(
            transaction.returnPath ?? ""
          )
        )
          throw new errors.JWTClaimValidationFailed(
            "Invalid account sign-in target",
            claims,
            "returnPath"
          )
        const returnPath =
          config.audience === "account"
            ? transaction.returnPath!
            : "/admin/subscriptions"
        response = redirect(returnPath, 303)
        response.headers.append(
          "Set-Cookie",
          await saveSession(config, session)
        )
      }
    }
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : undefined
    response =
      authenticationFailure(error) ||
      (typeof status === "number" && status < 500 && status !== 429)
        ? unauthenticated()
        : unavailable()
  }
  response.headers.append("Set-Cookie", setCookie(config, "", true))
  return response.status >= 400
    ? config.audience === "account"
      ? accountAuthPage(response)
      : adminAuthPage(response)
    : response
}
export async function handleAdminLogout(request: Request, env: Env) {
  return logout(request, env, "admin")
}
export async function handleAccountLogout(request: Request, env: Env) {
  return logout(request, env, "account")
}
async function logout(
  request: Request,
  env: Env,
  audience: "admin" | "account"
) {
  if (request.method !== "POST") return methodNotAllowed("POST")
  if (!sameOrigin(request))
    return json({ error: "Invalid request origin." }, 403)
  const config = configuration(request, env, audience)
  if (config instanceof Response) return config
  const session = await readSession(request, config)
  let location = "/"
  if (session) {
    try {
      // The sealed, client/origin-bound session was verified when stored. Its
      // session ID remains suitable for revocation after the access token expires.
      const claims = decodeJwt(session.accessToken)
      if (
        claims.client_id === config.clientId &&
        claims.sub === session.user.id &&
        typeof claims.sid === "string" &&
        claims.sid.length <= 128
      ) {
        location = config.workos.userManagement.getLogoutUrl({
          sessionId: claims.sid,
          returnTo: `${config.origin}/`,
        })
      }
    } catch {
      /* Always permit local sign-out when WorkOS is unavailable. */
    }
  }
  const response = redirect(location, 303)
  response.headers.append("Set-Cookie", setCookie(config, ""))
  response.headers.append("Set-Cookie", setCookie(config, "", true))
  return response
}
export function accountAuthPage(response: Response) {
  const headers = new Headers(response.headers)
  headers.set("Content-Type", "text/html; charset=utf-8")
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  )
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in · Photodepot</title><style>body{font:16px/1.6 system-ui;margin:12vh auto;max-width:440px;padding:32px;color:#20231e;background:#f6f4ef}</style><main><p>photodepot</p><h1>Sign-in could not be completed</h1><p>Return to Photodepot on your Mac and start sign-in again.</p></main></html>',
    { status: response.status, headers }
  )
}
function methodNotAllowed(method: string) {
  const response = json({ error: "Method not allowed." }, 405)
  response.headers.set("Allow", method)
  return response
}
