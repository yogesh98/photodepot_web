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
import { getAccountEntitlement } from "../../../lib/account-entitlement.ts"
import { resolveAccountAccess } from "../../../lib/account-access.ts"
import {
  AccountDeviceConflictError,
  listAccountDevices,
  removeAccountDevice,
} from "../../../lib/account-sessions.ts"

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
        [
          "request-renewal",
          "request-reset-device",
          "reset-device",
          "set-reminders",
        ].includes(body.action as string)
      )
        return respond(
          json(
            {
              error:
                "Access requests and manual grants have been retired. Manage your subscription from billing.",
            },
            410
          )
        )
      if (body.userId !== undefined || body.action !== "remove-device")
        return respond(json({ error: "Invalid account action." }, 400))
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
    }

    let access = resolveAccountAccess(null)
    let accessUnavailable = false
    try {
      access = (await getAccountEntitlement(env, auth.userId)).access
    } catch {
      // Account management does not require paid access. Failed authorization
      // checks must not hide the customer's devices or billing controls.
      accessUnavailable = true
    }
    return respond(
      json({
        user: { email: auth.email },
        access,
        accessUnavailable,
        devices: await listAccountDevices(env.DB, auth.userId),
      })
    )
  } catch (error) {
    const status =
      error instanceof BodyError
        ? error.status
        : error instanceof AccountDeviceConflictError
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
