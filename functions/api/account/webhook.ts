import { WorkOS } from "@workos-inc/node"
import type { PagesFunction } from "@cloudflare/workers-types"
import { BodyError, json, readText, type Env } from "../../../lib/cloudflare.ts"
import { activateSignupTrial } from "../../../lib/subscription-signup.ts"
import { subscriptionEnvironment } from "../../../lib/subscription-environment.ts"

export async function handleAccountWebhook(request: Request, env: Env) {
  if (request.method !== "POST") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "POST")
    return response
  }
  if (!env.WORKOS_WEBHOOK_SECRET || !env.WORKOS_CLIENT_ID)
    return json({ error: "Signup notifications are not configured." }, 503)
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Submit JSON." }, 415)
  const signature = request.headers.get("workos-signature")
  if (!signature) return json({ error: "Invalid notification." }, 401)
  try {
    subscriptionEnvironment(env)
    const payload = await readText(request)
    let event
    try {
      // Verify the exact body bytes, including whitespace, before trusting a user ID.
      event = await new WorkOS({
        clientId: env.WORKOS_CLIENT_ID,
      }).webhooks.constructEvent({
        payload,
        sigHeader: signature,
        secret: env.WORKOS_WEBHOOK_SECRET,
      })
    } catch {
      return json({ error: "Invalid notification." }, 401)
    }
    if (event.event !== "user.created") return json({ received: true })
    await activateSignupTrial(env.DB, event.data)
    return json({ received: true })
  } catch (error) {
    if (error instanceof BodyError)
      return json({ error: "Invalid notification." }, error.status)
    console.error("Signup subscription service unavailable")
    return json({ error: "Signup subscription service unavailable." }, 503)
  }
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleAccountWebhook(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
