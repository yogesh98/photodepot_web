import { createWorkOS } from "@workos-inc/node"
import { sealData, unsealData } from "iron-session"
import { errors } from "jose"
import { json, privateHeaders, type Env } from "./cloudflare.ts"
import {
  accountConfigurationError,
  authenticateWorkOSAccount,
  withAdminSession,
  type AdminAuth,
} from "./license-admin-auth.ts"
import {
  billingOrganization,
  storeWorkOSBillingSession,
} from "./workos-entitlements.ts"

const lifetime = 10 * 60
interface BillingTransaction {
  version: 1
  purpose: "photodepot-billing-authorization"
  state: string
  codeVerifier: string
  clientId: string
  origin: string
  userId: string
  organizationId: string
  customerId: string
  browserSessionId: string
}
function configuration(request: Request, env: Env) {
  const error = accountConfigurationError(request, env)
  if (error) throw error
  if (!env.WORKOS_API_KEY)
    throw json({ error: "Billing access is not configured." }, 503)
  const origin = new URL(request.url).origin
  const secure = new URL(origin).protocol === "https:"
  return {
    clientId: env.WORKOS_CLIENT_ID!,
    password: env.WORKOS_COOKIE_PASSWORD!,
    redirectUri: env.WORKOS_REDIRECT_URI!,
    origin,
    secure,
    name: `${secure ? "__Host-" : ""}photodepot-billing-auth`,
    workos: createWorkOS({
      apiKey: env.WORKOS_API_KEY,
      clientId: env.WORKOS_CLIENT_ID!,
      timeout: 5000,
      maxRetries: 0,
    }),
  }
}
type Configuration = ReturnType<typeof configuration>
function authCookie(config: Configuration, value: string) {
  if (value.length > 3800) throw new Error("Billing transaction is too large")
  return `${config.name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? lifetime : 0}${config.secure ? "; Secure" : ""}`
}
function readCookie(request: Request, config: Configuration) {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${config.name}=`))
  if (matches.length !== 1) return null
  const value = matches[0].slice(config.name.length + 1)
  return value.length <= 3800 ? value : null
}
function redirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: {
      ...privateHeaders,
      Location: location,
      "Referrer-Policy": "no-referrer",
    },
  })
}
async function personalOrganization(
  config: Configuration,
  env: Env,
  userId: string
) {
  const mapped = await billingOrganization(env, userId)
  if (!mapped)
    throw json({ error: "Start billing setup from your account." }, 409)
  const organization = await config.workos.organizations.getOrganization(
    mapped.organizationId
  )
  if (
    organization.id === env.WORKOS_ADMIN_ORGANIZATION_ID ||
    organization.externalId !== `photodepot-billing:${userId}` ||
    organization.stripeCustomerId !== mapped.customerId
  )
    throw json(
      { error: "Billing organization does not match this account." },
      409
    )
  return mapped
}
function methodNotAllowed() {
  const response = json({ error: "Method not allowed." }, 405)
  response.headers.set("Allow", "GET")
  return response
}
function failure(error: unknown) {
  if (error instanceof Response) return error
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined
  const authenticationError =
    error instanceof errors.JOSEError ||
    (typeof status === "number" && status < 500 && status !== 429)
  return json(
    {
      error: authenticationError
        ? "Billing authorization expired or could not be verified. Start again from your account."
        : "Billing authorization is temporarily unavailable. Please try again.",
    },
    authenticationError ? 401 : 503
  )
}

/** The account cookie authorizes starting a new, independent AuthKit grant. */
export async function handleWorkOSBillingAuthorize(request: Request, env: Env) {
  if (request.method !== "GET") return methodNotAllowed()
  const auth = await authenticateWorkOSAccount(request, env)
  if (auth instanceof Response) return auth
  try {
    const config = configuration(request, env)
    const organization = await personalOrganization(config, env, auth.userId)
    const authorization =
      await config.workos.userManagement.getAuthorizationUrlWithPKCE({
        provider: "authkit",
        redirectUri: config.redirectUri,
        organizationId: organization.organizationId,
        screenHint: "sign-in",
      })
    const state = `billing_${authorization.state}`
    const authorizationUrl = new URL(authorization.url)
    authorizationUrl.searchParams.set("state", state)
    const transaction: BillingTransaction = {
      version: 1,
      purpose: "photodepot-billing-authorization",
      state,
      codeVerifier: authorization.codeVerifier,
      clientId: config.clientId,
      origin: config.origin,
      userId: auth.userId,
      organizationId: organization.organizationId,
      customerId: organization.customerId,
      browserSessionId: auth.sessionId,
    }
    const response = redirect(authorizationUrl.href)
    response.headers.append(
      "Set-Cookie",
      authCookie(
        config,
        await sealData(transaction, {
          password: config.password,
          ttl: lifetime,
        })
      )
    )
    return withAdminSession(response, auth)
  } catch (error) {
    return withAdminSession(failure(error), auth)
  }
}

/** Shared callback dispatches only the sealed transaction's dedicated billing state. */
export async function handleWorkOSBillingCallback(request: Request, env: Env) {
  if (request.method !== "GET") return methodNotAllowed()
  let config: Configuration | undefined
  let accountAuth: AdminAuth | undefined
  let response: Response
  try {
    config = configuration(request, env)
    const auth = await authenticateWorkOSAccount(request, env)
    if (auth instanceof Response) {
      response = auth
    } else {
      accountAuth = auth
      const query = new URL(request.url).searchParams
      const value = readCookie(request, config)
      const transaction = value
        ? await unsealData<BillingTransaction>(value, {
            password: config.password,
            ttl: lifetime,
          })
        : undefined
      if (
        !transaction ||
        transaction.version !== 1 ||
        transaction.purpose !== "photodepot-billing-authorization" ||
        !transaction.state?.startsWith("billing_") ||
        transaction.state !== query.get("state") ||
        transaction.clientId !== config.clientId ||
        transaction.origin !== config.origin ||
        transaction.userId !== auth.userId ||
        transaction.browserSessionId !== auth.sessionId ||
        typeof transaction.codeVerifier !== "string" ||
        !transaction.codeVerifier ||
        query.has("error") ||
        !query.get("code") ||
        query.get("code")!.length > 2000
      ) {
        response = json(
          {
            error:
              "Billing authorization expired or could not be verified. Start again from your account.",
          },
          401
        )
      } else {
        const organization = await personalOrganization(
          config,
          env,
          auth.userId
        )
        if (
          organization.organizationId !== transaction.organizationId ||
          organization.customerId !== transaction.customerId
        )
          throw json(
            {
              error: "Billing account changed. Start again from your account.",
            },
            409
          )
        const result =
          await config.workos.userManagement.authenticateWithCodeAndVerifier({
            code: query.get("code")!,
            codeVerifier: transaction.codeVerifier,
          })
        if (result.user.id !== auth.userId || !result.user.emailVerified)
          throw json(
            {
              error:
                "Sign in with the same Photodepot account to connect billing.",
            },
            401
          )
        await storeWorkOSBillingSession(env, {
          userId: auth.userId,
          organizationId: transaction.organizationId,
          browserSessionId: auth.sessionId,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        })
        response = redirect(`${config.origin}/account?billing=connected`)
      }
      response = withAdminSession(response, auth)
    }
  } catch (error) {
    response = accountAuth
      ? withAdminSession(failure(error), accountAuth)
      : failure(error)
  }
  if (config) response.headers.append("Set-Cookie", authCookie(config, ""))
  return response
}
