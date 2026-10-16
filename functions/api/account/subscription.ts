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
  changeSubscriptionReminders,
  SubscriptionConflictError,
} from "../../../lib/subscription-store.ts"
import { getAccountEntitlement } from "../../../lib/account-entitlement.ts"
import {
  AccountDeviceConflictError,
  listAccountDevices,
  removeAccountDevice,
} from "../../../lib/account-sessions.ts"
import {
  AccountRequestLimitError,
  createAccountRequest,
  listAccountRequests,
} from "../../../lib/account-requests.ts"

export async function handleAccountSubscription(request: Request, env: Env) {
  const auth = await authenticateWorkOSAccount(request, env)
  if (auth instanceof Response) return auth
  const respond = (response: Response) => withAdminSession(response, auth)
  try {
    if (!["GET", "POST"].includes(request.method)) {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
      return respond(response)
    }
    if (request.method === "POST") {
      if (!sameOrigin(request))
        return respond(json({ error: "Invalid request origin." }, 403))
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        return respond(json({ error: "Submit JSON." }, 415))
      const supplied = await readJson(request)
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
        return respond(json({ error: "Invalid request." }, 400))
      const body = supplied as Record<string, unknown>
      if (
        body.userId !== undefined ||
        !["request-renewal", "remove-device", "set-reminders"].includes(
          body.action as string
        )
      )
        return respond(json({ error: "Invalid account request." }, 400))
      if (body.action === "set-reminders") {
        if (
          body.deviceId !== undefined ||
          body.sessionId !== undefined ||
          body.message !== undefined
        )
          return respond(json({ error: "Choose a reminder preference." }, 400))
        const grant = await changeSubscriptionReminders(
          env.DB,
          auth.userId,
          body.enabled as boolean,
          body.expectedRevision as number,
          auth.email,
          Date.now(),
          "Customer reminder preference"
        )
        return respond(
          json({
            access: (await getAccountEntitlement(env, auth.userId)).access,
            reminders: {
              enabled: grant.remindersEnabled,
              revision: grant.revision,
            },
          })
        )
      }
      if (body.action === "remove-device") {
        if (body.message !== undefined)
          return respond(json({ error: "Choose a current computer." }, 400))
        const devices = await removeAccountDevice(
          env.DB,
          auth.userId,
          body.sessionId as string,
          body.expectedSessionRevision as number,
          auth.email,
          Date.now(),
          "Customer self-service computer removal"
        )
        return respond(json({ devices }))
      }
      if (body.deviceId !== undefined || body.sessionId !== undefined)
        return respond(
          json({ error: "An access request does not select a computer." }, 400)
        )
      const result = await createAccountRequest(env.DB, {
        userId: auth.userId,
        email: auth.email,
        action: "renewal",
        message: body.message as string | undefined,
      })
      return respond(json(result, result.created ? 201 : 200))
    }
    const entitlement = await getAccountEntitlement(env, auth.userId)
    const grant = entitlement.manual
    return respond(
      json({
        user: { email: auth.email },
        access: entitlement.access,
        reminders: {
          enabled: grant?.remindersEnabled ?? true,
          revision: grant?.revision ?? 0,
        },
        devices: await listAccountDevices(env.DB, auth.userId),
        requests: await listAccountRequests(env.DB, auth.userId),
      })
    )
  } catch (error) {
    const status =
      error instanceof BodyError
        ? error.status
        : error instanceof AccountRequestLimitError
          ? 429
          : error instanceof SubscriptionConflictError ||
              error instanceof AccountDeviceConflictError
            ? 409
            : error instanceof TypeError
              ? 400
              : 503
    return respond(
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
      )
    )
  }
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAccountSubscription(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
