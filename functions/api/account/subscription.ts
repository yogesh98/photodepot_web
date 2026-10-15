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
import {
  changeSubscriptionRenewal,
  getSubscription,
  SubscriptionConflictError,
} from "../../../lib/subscription-store.ts"
import type { SubscriptionSummary } from "../../../lib/subscription-types.ts"
import { resetSubscriptionDevice } from "../../../lib/subscription-devices.ts"
import {
  AccountRequestLimitError,
  createAccountRequest,
  listAccountRequests,
  type CustomerSubscription,
} from "../../../lib/account-requests.ts"

function customerSubscription(
  subscription: SubscriptionSummary | null
): CustomerSubscription | null {
  return subscription
    ? {
        type: subscription.type,
        status: subscription.status,
        startsAt: subscription.startsAt,
        endsAt: subscription.endsAt,
        revision: subscription.revision,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: subscription.canceledAt,
        deviceLimit: subscription.deviceLimit,
        devices: subscription.devices.map((device) => ({
          id: device.id,
          activatedAt: device.activatedAt,
        })),
      }
    : null
}

export async function handleAccountSubscription(request: Request, env: Env) {
  const auth = await authenticateWorkOSAccount(request, env)
  if (auth instanceof Response) return auth
  try {
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
        ![
          "request-renewal",
          "remove-device",
          "cancel-renewal",
          "resume-renewal",
        ].includes(body.action as string) ||
        (body.message !== undefined &&
          (typeof body.message !== "string" || body.message.length > 1000))
      )
        return withAdminSession(
          json({ error: "Invalid account request." }, 400),
          auth
        )
      if (
        body.action === "cancel-renewal" ||
        body.action === "resume-renewal"
      ) {
        if (body.deviceId !== undefined || body.message !== undefined)
          return withAdminSession(
            json(
              {
                error:
                  "A renewal preference does not select a Mac or create a support request.",
              },
              400
            ),
            auth
          )
        const updated = await changeSubscriptionRenewal(
          env.DB,
          auth.userId,
          body.action,
          body.expectedRevision as number,
          auth.email,
          Date.now(),
          "Customer self-service"
        )
        return withAdminSession(
          json({ subscription: customerSubscription(updated) }),
          auth
        )
      }
      if (body.action === "remove-device") {
        if (
          typeof body.deviceId !== "string" ||
          !subscription?.devices.some(
            (device) => device.id === body.deviceId
          ) ||
          body.message !== undefined
        )
          return withAdminSession(
            json({ error: "Choose one of your current Mac assignments." }, 400),
            auth
          )
        const updated = await resetSubscriptionDevice(
          env.DB,
          auth.userId,
          body.expectedRevision as number,
          auth.email,
          Date.now(),
          "Customer self-service Mac removal",
          body.deviceId
        )
        return withAdminSession(
          json({ subscription: customerSubscription(updated) }),
          auth
        )
      }
      if (body.action === "request-renewal" && body.deviceId !== undefined)
        return withAdminSession(
          json({ error: "A renewal request does not select a Mac." }, 400),
          auth
        )
      if (
        body.action === "request-renewal" &&
        subscription?.cancelAtPeriodEnd &&
        subscription.status === "active"
      )
        return withAdminSession(
          json(
            { error: "Resume renewal before submitting a renewal request." },
            400
          ),
          auth
        )
      const result = await createAccountRequest(env.DB, {
        userId: auth.userId,
        email: auth.email,
        action: "renewal",
        message: body.message as string | undefined,
      })
      return withAdminSession(json(result, result.created ? 201 : 200), auth)
    }
    return withAdminSession(
      json({
        user: { email: auth.email },
        subscription: customerSubscription(subscription),
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
          : error instanceof SubscriptionConflictError
            ? 409
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
