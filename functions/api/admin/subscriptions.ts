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
import {
  listWorkOSUsers,
  getWorkOSUser,
  WORKOS_USER_ID,
} from "../../../lib/workos-users.ts"
import {
  changeSubscription,
  getSubscription,
  getSubscriptionOverview,
  INITIAL_TRIAL_DAYS,
  listSubscriptionAudit,
  listSubscriptions,
  setSubscription,
  SubscriptionConflictError,
  updateSubscriptionNotes,
} from "../../../lib/subscription-store.ts"
import {
  listSubscriptionDevices,
  resetSubscriptionDevice,
} from "../../../lib/subscription-devices.ts"
import { subscriptionEnvironment } from "../../../lib/subscription-environment.ts"

export async function handleAdminSubscriptions(request: Request, env: Env) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  return withAdminSession(await authorized(request, env, auth), auth)
}

async function authorized(request: Request, env: Env, auth: AdminAuth) {
  try {
    const environment = subscriptionEnvironment(env)
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams
      const now = Date.now()
      if (query.has("history")) {
        const userId = query.get("userId") ?? ""
        if (!WORKOS_USER_ID.test(userId))
          return json({ error: "Invalid user." }, 400)
        const [subscription, devices, audit] = await Promise.all([
          getSubscription(env.DB, userId, now),
          listSubscriptionDevices(env.DB, userId),
          listSubscriptionAudit(env.DB, userId),
        ])
        return json({ subscription, devices, audit })
      }
      const cursor = query.get("cursor") ?? undefined
      if (cursor && !WORKOS_USER_ID.test(cursor))
        return json({ error: "Invalid page." }, 400)
      const [page, overview] = await Promise.all([
        listWorkOSUsers(env, cursor),
        getSubscriptionOverview(env.DB, now),
      ])
      const subscriptions = await listSubscriptions(
        env.DB,
        page.users.map((user) => user.id),
        now
      )
      return json({
        users: page.users.map((user) => ({
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          emailVerified: user.emailVerified,
          createdAt: Date.parse(user.createdAt),
          subscription: subscriptions.get(user.id) ?? null,
        })),
        nextCursor: page.nextCursor,
        overview,
        environment,
        billingMode: "manual",
        trialDays: INITIAL_TRIAL_DAYS,
      })
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
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 0 ||
      (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER ||
      ![
        "set",
        "extend",
        "revoke",
        "restore",
        "reset-device",
        "update-notes",
      ].includes(body.action as string)
    )
      return json({ error: "Invalid subscription action." }, 400)
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
    if (
      body.deviceId !== undefined &&
      (body.action !== "reset-device" ||
        typeof body.deviceId !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.deviceId))
    )
      return json({ error: "Choose a current Mac assignment to reset." }, 400)
    const now = Date.now()
    if (body.action === "set" || body.action === "extend") {
      if (body.endsAt !== undefined) {
        if (body.durationDays !== undefined)
          return json(
            { error: "Choose an expiration date or a number of days." },
            400
          )
        if (
          !Number.isSafeInteger(body.endsAt) ||
          (body.endsAt as number) <= now ||
          (body.endsAt as number) > 8_640_000_000_000_000
        )
          return json({ error: "Choose a valid future expiration date." }, 400)
      } else if (
        !Number.isSafeInteger(body.durationDays) ||
        (body.durationDays as number) < 1 ||
        (body.durationDays as number) > 3650
      )
        return json({ error: "Choose between 1 and 3,650 whole days." }, 400)
    }
    if (
      body.action === "set" &&
      body.type !== "trial" &&
      body.type !== "regular"
    )
      return json({ error: "Choose Trial or Standard." }, 400)
    if (body.action !== "set" && (body.expectedRevision as number) < 1)
      return json(
        { error: "Assign a subscription before changing its access or notes." },
        400
      )
    if (body.action === "update-notes" && typeof body.notes !== "string")
      return json(
        {
          error:
            "Enter administrator notes, or leave them empty to clear them.",
        },
        400
      )
    const user = await getWorkOSUser(env, body.userId)
    if (!user)
      return json({ error: "This user no longer exists in WorkOS." }, 404)
    const revision = body.expectedRevision as number
    const reason = body.reason as string | undefined
    const subscription =
      body.action === "set"
        ? await setSubscription(
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
        : body.action === "update-notes"
          ? await updateSubscriptionNotes(
              env.DB,
              user.id,
              body.notes as string,
              revision,
              auth.email,
              now,
              reason
            )
          : body.action === "reset-device"
            ? await resetSubscriptionDevice(
                env.DB,
                user.id,
                revision,
                auth.email,
                now,
                reason,
                body.deviceId as string | undefined
              )
            : await changeSubscription(
                env.DB,
                user.id,
                body.action as "extend" | "revoke" | "restore",
                revision,
                auth.email,
                body.durationDays as number | undefined,
                now,
                { reason, endsAt: body.endsAt as number | undefined }
              )
    return json(
      { subscription },
      body.action === "set" && revision === 0 ? 201 : 200
    )
  } catch (error) {
    if (error instanceof BodyError)
      return json({ error: "Invalid request." }, error.status)
    if (error instanceof SubscriptionConflictError)
      return json({ error: error.message }, 409)
    if (error instanceof TypeError) return json({ error: error.message }, 400)
    console.error("Subscription administration service unavailable")
    return json(
      {
        error: env.WORKOS_API_KEY
          ? "Subscription administration is temporarily unavailable. Please try again."
          : "WorkOS user management is not configured. Add the encrypted WORKOS_API_KEY server secret.",
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
