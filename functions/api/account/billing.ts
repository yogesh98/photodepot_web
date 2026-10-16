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
  billingConfiguration,
  billingSummary,
  createBillingCheckout,
  createBillingPortal,
} from "../../../lib/stripe-billing.ts"
import { BillingConflictError } from "../../../lib/stripe-billing-store.ts"

export async function handleAccountBilling(request: Request, env: Env) {
  const auth = await authenticateWorkOSAccount(request, env)
  if (auth instanceof Response) return auth
  const respond = (response: Response) => withAdminSession(response, auth)
  try {
    if (request.method === "GET")
      return respond(json(await billingSummary(env, auth.userId)))
    if (request.method !== "POST") {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
      return respond(response)
    }
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
    const config = billingConfiguration(env, true)
    if (config && new URL(request.url).origin !== config.origin)
      return respond(
        json({ error: "Billing is unavailable on this hostname." }, 403)
      )
    const supplied = await readJson(request)
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      throw new TypeError("Invalid billing request.")
    const body = supplied as Record<string, unknown>
    const keys = Object.keys(body)
    if (
      body.action === "checkout" &&
      keys.every((key) => ["action", "interval"].includes(key)) &&
      ["monthly", "annual"].includes(body.interval as string)
    )
      return respond(
        json(
          await createBillingCheckout(
            env,
            auth,
            body.interval as "monthly" | "annual"
          )
        )
      )
    if (body.action === "portal" && keys.length === 1)
      return respond(json(await createBillingPortal(env, auth)))
    throw new TypeError("Choose an available billing action.")
  } catch (error) {
    const status =
      error instanceof BodyError
        ? error.status
        : error instanceof TypeError
          ? 400
          : error instanceof BillingConflictError
            ? 409
            : 503
    if (status === 503) console.error("Account billing temporarily unavailable")
    return respond(
      json(
        {
          error:
            status === 503
              ? "Billing is temporarily unavailable. Please try again."
              : error instanceof Error
                ? error.message
                : "Invalid billing request.",
        },
        status
      )
    )
  }
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleAccountBilling(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
