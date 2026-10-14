import type { PagesFunction } from "@cloudflare/workers-types"
import {
  authenticateWorkOSAccount,
  withAdminSession,
} from "../../../lib/license-admin-auth.ts"
import {
  BodyError,
  json,
  readJson,
  sameOrigin,
  type Env,
} from "../../../lib/cloudflare.ts"
import { getSubscription } from "../../../lib/subscription-store.ts"
import { subscriptionEnvironment } from "../../../lib/subscription-environment.ts"
import {
  AccountRequestLimitError,
  createAccountRequest,
  listAccountRequests,
  type CustomerSubscription,
} from "../../../lib/account-requests.ts"

export async function handleAccountSubscription(request: Request, env: Env) {
  const auth = await authenticateWorkOSAccount(request, env)
  if (auth instanceof Response) return auth
  try {
    const environment = subscriptionEnvironment(env)
    if (!["GET", "POST"].includes(request.method)) {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
      return withAdminSession(response, auth)
    }
    const subscription = await getSubscription(env.DB, auth.userId)
    if (request.method === "POST") {
      if (!sameOrigin(request))
        return withAdminSession(
          json({ error: "Invalid request origin." }, 403),
          auth
        )
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        return withAdminSession(json({ error: "Submit JSON." }, 415), auth)
      const supplied = await readJson(request)
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
        return withAdminSession(json({ error: "Invalid request." }, 400), auth)
      const body = supplied as Record<string, unknown>
      if (
        body.userId !== undefined ||
        !["request-renewal", "request-device-reset"].includes(
          body.action as string
        ) ||
        (body.message !== undefined &&
          (typeof body.message !== "string" || body.message.length > 1000))
      )
        return withAdminSession(
          json({ error: "Invalid account request." }, 400),
          auth
        )
      if (
        body.action === "request-device-reset" &&
        (typeof body.deviceId !== "string" ||
          !subscription?.devices.some((device) => device.id === body.deviceId))
      )
        return withAdminSession(
          json({ error: "Choose one of your current Mac assignments." }, 400),
          auth
        )
      if (body.action === "request-renewal" && body.deviceId !== undefined)
        return withAdminSession(
          json({ error: "A renewal request does not select a Mac." }, 400),
          auth
        )
      const result = await createAccountRequest(env.DB, {
        userId: auth.userId,
        email: auth.email,
        action: body.action === "request-renewal" ? "renewal" : "reset-device",
        deviceId: body.deviceId as string | undefined,
        message: body.message as string | undefined,
      })
      return withAdminSession(json(result, result.created ? 201 : 200), auth)
    }
    const safeSubscription: CustomerSubscription | null = subscription
      ? {
          type: subscription.type,
          status: subscription.status,
          startsAt: subscription.startsAt,
          endsAt: subscription.endsAt,
          deviceLimit: subscription.deviceLimit,
          devices: subscription.devices.map((device) => ({
            id: device.id,
            activatedAt: device.activatedAt,
          })),
        }
      : null
    return withAdminSession(
      json({
        environment,
        user: { email: auth.email },
        subscription: safeSubscription,
        requests: await listAccountRequests(env.DB, auth.userId),
      }),
      auth
    )
  } catch (error) {
    const status =
      error instanceof BodyError
        ? error.status
        : error instanceof AccountRequestLimitError
          ? 429
          : error instanceof TypeError
            ? 400
            : 503
    return withAdminSession(
      json(
        {
          error:
            status === 503
              ? "Your account is temporarily unavailable. Please try again."
              : error instanceof Error
                ? error.message
                : "Invalid request.",
        },
        status
      ),
      auth
    )
  }
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAccountSubscription(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
