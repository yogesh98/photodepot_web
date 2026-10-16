import type { PagesFunction } from "@cloudflare/workers-types"
import {
  authenticateLicenseAdmin,
  withAdminSession,
  type AdminAuth,
} from "../../../lib/license-admin-auth.ts"
import {
  BodyError,
  json,
  readJson,
  sameOrigin,
  type Env,
} from "../../../lib/cloudflare.ts"
import { getWorkOSUser, WORKOS_USER_ID } from "../../../lib/workos-users.ts"
import {
  getSubscriptionOverview,
  listSubscriptionAudit,
} from "../../../lib/subscription-store.ts"
import {
  AccountDeviceConflictError,
  listAccountDeviceHistory,
  removeAccountDevice,
} from "../../../lib/account-sessions.ts"
import { getAccountEntitlement } from "../../../lib/account-entitlement.ts"
import { listAdminUsers } from "../../../lib/admin-directory.ts"

export async function handleAdminSubscriptions(request: Request, env: Env) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  return withAdminSession(await authorized(request, env, auth), auth)
}

async function authorized(request: Request, env: Env, auth: AdminAuth) {
  try {
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams
      const now = Date.now()
      if (query.has("history")) {
        const userId = query.get("userId") ?? ""
        if (!WORKOS_USER_ID.test(userId))
          return json({ error: "Invalid user." }, 400)
        const [user, entitlement, devices, audit, deviceAudit] =
          await Promise.all([
            getWorkOSUser(env, userId),
            getAccountEntitlement(env, userId, now),
            listAccountDeviceHistory(env.DB, userId),
            listSubscriptionAudit(env.DB, userId),
            env.DB.prepare(
              `SELECT id,session_id AS sessionId,action,actor,created_at AS createdAt,reason FROM account_device_audit WHERE user_id = ? ORDER BY created_at DESC,id DESC LIMIT 100`
            )
              .bind(userId)
              .all(),
          ])
        if (!user)
          return json({ error: "This user no longer exists in WorkOS." }, 404)
        const { manual: subscription, access, billing, managed } = entitlement
        return json({
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            emailVerified: user.emailVerified,
            createdAt: Date.parse(user.createdAt),
            subscription,
            billing,
            managed,
            access,
            devices: devices
              .filter((device) => device.current)
              .map(({ current, ...device }) => {
                void current
                return device
              }),
          },
          subscription,
          billing,
          managed,
          access,
          devices,
          audit,
          deviceAudit: deviceAudit.results,
        })
      }
      const page = await listAdminUsers(env, query, now)
      // Include this bounded page's completed proof refreshes in the same response.
      const overview = await getSubscriptionOverview(env.DB)
      return json({ ...page, overview, billingMode: "subscriptions" })
    }
    if (request.method !== "POST") {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
      return response
    }
    if (!sameOrigin(request))
      return json({ error: "Invalid request origin." }, 403)
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      return json({ error: "Submit JSON." }, 415)
    const supplied = await readJson(request)
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      return json({ error: "Invalid request." }, 400)
    const body = supplied as Record<string, unknown>
    if (
      [
        "set",
        "extend",
        "revoke",
        "restore",
        "update-notes",
        "set-reminders",
        "approve",
      ].includes(body.action as string)
    )
      return json(
        {
          error:
            "Manual access administration has been retired. Manage subscriptions and discounts in Stripe.",
        },
        410
      )
    if (
      body.action !== "remove-device" ||
      typeof body.userId !== "string" ||
      !WORKOS_USER_ID.test(body.userId)
    )
      return json({ error: "Invalid account action." }, 400)
    if (
      body.reason !== undefined &&
      (typeof body.reason !== "string" || body.reason.length > 1000)
    )
      return json({ error: "Enter a reason of at most 1,000 characters." }, 400)
    if (body.deviceId !== undefined)
      return json({ error: "Select a current computer session." }, 400)
    const user = await getWorkOSUser(env, body.userId)
    if (!user)
      return json({ error: "This user no longer exists in WorkOS." }, 404)
    const devices = await removeAccountDevice(
      env.DB,
      user.id,
      body.sessionId as string,
      body.expectedSessionRevision as number,
      auth.email,
      Date.now(),
      body.reason as string | undefined
    )
    return json({ devices })
  } catch (error) {
    if (error instanceof BodyError)
      return json({ error: "Invalid request." }, error.status)
    if (error instanceof AccountDeviceConflictError)
      return json({ error: error.message }, 409)
    if (error instanceof TypeError) return json({ error: error.message }, 400)
    console.error("Access administration service unavailable")
    return json(
      {
        error:
          "Access administration is temporarily unavailable. Please try again.",
      },
      503
    )
  }
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAdminSubscriptions(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
