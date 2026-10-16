import Stripe from "stripe"
import type { PagesFunction } from "@cloudflare/workers-types"
import { BodyError, json, type Env } from "../../../lib/cloudflare.ts"
import {
  billingConfiguration,
  createBillingStripe,
  processBillingEvent,
} from "../../../lib/stripe-billing.ts"

/** Read the exact signed UTF-8 body with a separate limit for Stripe invoices. */
async function webhookBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new BodyError(400)
  try {
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > 262_144) {
        await reader.cancel()
        throw new BodyError(413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes
      )
    } catch {
      throw new BodyError(400)
    }
  } finally {
    reader.releaseLock()
  }
}

export async function handleBillingWebhook(request: Request, env: Env) {
  if (request.method !== "POST") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "POST")
    return response
  }
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Submit JSON." }, 415)
  const signature = request.headers.get("stripe-signature")
  if (!signature) return json({ error: "Invalid notification." }, 401)
  try {
    const config = billingConfiguration(env, true)
    if (!config)
      return json({ error: "Billing notifications are not enabled." }, 503)
    const payload = await webhookBody(request)
    let event: Stripe.Event
    try {
      event = await createBillingStripe(config).webhooks.constructEventAsync(
        payload,
        signature,
        config.webhookSecret,
        300,
        Stripe.createSubtleCryptoProvider()
      )
    } catch {
      return json({ error: "Invalid notification." }, 401)
    }
    await processBillingEvent(env, event)
    return json({ received: true })
  } catch (error) {
    if (error instanceof BodyError)
      return json({ error: "Invalid notification." }, error.status)
    console.error("Billing notification reconciliation unavailable")
    return json(
      { error: "Billing notification reconciliation unavailable." },
      503
    )
  }
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleBillingWebhook(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
