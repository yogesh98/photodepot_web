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
  changeSubscription,
  changeSubscriptionReminders,
  getSubscription,
  getSubscriptionOverview,
  listSubscriptionAudit,
  setSubscription,
  SubscriptionConflictError,
  updateSubscriptionNotes,
} from "../../../lib/subscription-store.ts"
import {
  AccountDeviceConflictError,
  listAccountDeviceHistory,
  removeAccountDevice,
} from "../../../lib/account-sessions.ts"
import { resolveAccountAccess } from "../../../lib/account-access.ts"
import { listAdminUsers } from "../../../lib/admin-directory.ts"
import { listUserAdminRequests } from "../../../lib/account-requests.ts"

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
        const [user, subscription, devices, audit, requests, deviceAudit] =
          await Promise.all([
            getWorkOSUser(env, userId),
            getSubscription(env.DB, userId, now),
            listAccountDeviceHistory(env.DB, userId),
            listSubscriptionAudit(env.DB, userId),
            listUserAdminRequests(env.DB, userId),
            env.DB.prepare(
              `SELECT id,session_id AS sessionId,action,actor,created_at AS createdAt,reason FROM account_device_audit WHERE user_id = ? ORDER BY created_at DESC,id DESC LIMIT 100`
            )
              .bind(userId)
              .all(),
          ])
        if (!user)
          return json({ error: "This user no longer exists in WorkOS." }, 404)
        const access = resolveAccountAccess(subscription, now)
        return json({
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            emailVerified: user.emailVerified,
            createdAt: Date.parse(user.createdAt),
            subscription,
            access,
            devices: devices
              .filter((device) => device.current)
              .map(({ current, ...device }) => {
                void current
                return device
              }),
          },
          subscription,
          access,
          devices,
          audit,
          requests,
          deviceAudit: deviceAudit.results,
        })
      }
      const [page, overview] = await Promise.all([
        listAdminUsers(env, query, now),
        getSubscriptionOverview(env.DB, now),
      ])
      return json({ ...page, overview, billingMode: "manual" })
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
      typeof body.userId !== "string" ||
      !WORKOS_USER_ID.test(body.userId) ||
      ![
        "set",
        "extend",
        "revoke",
        "restore",
        "update-notes",
        "set-reminders",
        "remove-device",
      ].includes(body.action as string)
    )
      return json({ error: "Invalid access action." }, 400)
    if (
      body.reason !== undefined &&
      (typeof body.reason !== "string" || body.reason.length > 1000)
    )
      return json({ error: "Enter a reason of at most 1,000 characters." }, 400)
    if (
      body.notes !== undefined &&
      (typeof body.notes !== "string" || body.notes.length > 2000)
    )
      return json({ error: "Enter notes of at most 2,000 characters." }, 400)
    if (body.deviceId !== undefined)
      return json({ error: "Select a current computer session." }, 400)
    if (
      body.action === "set" &&
      body.type !== "trial" &&
      body.type !== "regular"
    )
      return json({ error: "Choose Trial or Standard." }, 400)
    const now = Date.now()
    const reason = body.reason as string | undefined
    if (body.action === "remove-device") {
      const user = await getWorkOSUser(env, body.userId)
      if (!user)
        return json({ error: "This user no longer exists in WorkOS." }, 404)
      const devices = await removeAccountDevice(
        env.DB,
        user.id,
        body.sessionId as string,
        body.expectedSessionRevision as number,
        auth.email,
        now,
        reason
      )
      return json({ devices })
    }
    if (
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < (body.action === "set" ? 0 : 1) ||
      (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
    )
      return json({ error: "Invalid access revision." }, 400)
    const revision = body.expectedRevision as number
    if (body.action === "set" || body.action === "extend") {
      if (body.endsAt !== undefined) {
        if (
          body.durationDays !== undefined ||
          !Number.isSafeInteger(body.endsAt) ||
          (body.endsAt as number) <= now ||
          (body.endsAt as number) > 8_640_000_000_000_000
        )
          return json(
            { error: "Choose a valid future expiration or a number of days." },
            400
          )
      } else if (
        !Number.isSafeInteger(body.durationDays) ||
        (body.durationDays as number) < 1 ||
        (body.durationDays as number) > 3650
      )
        return json({ error: "Choose between 1 and 3,650 whole days." }, 400)
    }
    if (body.action === "update-notes" && typeof body.notes !== "string")
      return json({ error: "Enter administrator notes." }, 400)
    const user = await getWorkOSUser(env, body.userId)
    if (!user)
      return json({ error: "This user no longer exists in WorkOS." }, 404)
    let subscription
    if (body.action === "set") {
      subscription = await setSubscription(
        env.DB,
        {
          userId: user.id,
          type: body.type as "trial" | "regular",
          endsAt:
            (body.endsAt as number | undefined) ??
            now + (body.durationDays as number) * 86_400_000,
          expectedRevision: revision,
          notes: body.notes as string | undefined,
          reason,
        },
        auth.email,
        now
      )
    } else if (body.action === "update-notes") {
      subscription = await updateSubscriptionNotes(
        env.DB,
        user.id,
        body.notes as string,
        revision,
        auth.email,
        now,
        reason
      )
    } else if (body.action === "set-reminders") {
      subscription = await changeSubscriptionReminders(
        env.DB,
        user.id,
        body.enabled as boolean,
        revision,
        auth.email,
        now,
        reason
      )
    } else {
      subscription = await changeSubscription(
        env.DB,
        user.id,
        body.action as "extend" | "revoke" | "restore",
        revision,
        auth.email,
        body.durationDays as number | undefined,
        now,
        { reason, endsAt: body.endsAt as number | undefined }
      )
    }
    return json(
      { subscription, access: resolveAccountAccess(subscription, now) },
      body.action === "set" && revision === 0 ? 201 : 200
    )
  } catch (error) {
    if (error instanceof BodyError)
      return json({ error: "Invalid request." }, error.status)
    if (
      error instanceof SubscriptionConflictError ||
      error instanceof AccountDeviceConflictError
    )
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
