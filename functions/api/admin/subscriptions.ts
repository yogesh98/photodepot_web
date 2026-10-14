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
  listSubscriptionAudit,
  listSubscriptions,
  setSubscription,
  SubscriptionConflictError,
} from "../../../lib/subscription-store.ts"
import { resetSubscriptionDevice } from "../../../lib/subscription-devices.ts"

export async function handleAdminSubscriptions(request: Request, env: Env) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  return withAdminSession(await authorized(request, env, auth), auth)
}

async function authorized(request: Request, env: Env, auth: AdminAuth) {
  try {
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams
      if (query.has("history")) {
        const userId = query.get("userId") ?? ""
        if (!WORKOS_USER_ID.test(userId))
          return json({ error: "Invalid user." }, 400)
        return json({ audit: await listSubscriptionAudit(env.DB, userId) })
      }
      const cursor = query.get("cursor") ?? undefined
      if (cursor && !WORKOS_USER_ID.test(cursor))
        return json({ error: "Invalid page." }, 400)
      const page = await listWorkOSUsers(env, cursor)
      const subscriptions = await listSubscriptions(
        env.DB,
        page.users.map((user) => user.id)
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
      })
    }
    if (request.method !== "POST") {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
      return response
    }
    if (!sameOrigin(request))
      return json({ error: "Invalid request origin." }, 403)
    if (!request.headers.get("content-type")?.startsWith("application/json"))
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
      !["set", "extend", "revoke", "restore", "reset-device"].includes(
        body.action as string
      )
    )
      return json({ error: "Invalid subscription action." }, 400)
    if (body.action === "set" || body.action === "extend") {
      if (
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
    if (body.action === "reset-device" && (body.expectedRevision as number) < 1)
      return json(
        { error: "Assign a subscription before resetting Mac access." },
        400
      )
    const user = await getWorkOSUser(env, body.userId)
    if (!user)
      return json({ error: "This user no longer exists in WorkOS." }, 404)
    const revision = body.expectedRevision as number
    const now = Date.now()
    const subscription =
      body.action === "set"
        ? await setSubscription(
            env.DB,
            {
              userId: user.id,
              type: body.type as "trial" | "regular",
              endsAt: now + (body.durationDays as number) * 86_400_000,
              expectedRevision: revision,
            },
            auth.email,
            now
          )
        : body.action === "reset-device"
          ? await resetSubscriptionDevice(
              env.DB,
              user.id,
              revision,
              auth.email,
              now
            )
          : await changeSubscription(
              env.DB,
              user.id,
              body.action as "extend" | "revoke" | "restore",
              revision,
              auth.email,
              body.durationDays as number | undefined,
              now
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
