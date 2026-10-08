import type { PagesFunction } from "@cloudflare/workers-types"
import { saveWaitlistEntry } from "../../lib/waitlist.ts"
import { validateWaitlistEntry } from "../../lib/waitlist-validation.ts"
import {
  BodyError,
  json,
  readJson,
  sameOrigin,
  type Env,
} from "../../lib/cloudflare.ts"

export async function handleWaitlist(request: Request, env: Env) {
  if (request.method !== "POST") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "POST")
    return response
  }
  if (!sameOrigin(request)) return json({ error: "Invalid request." }, 403)
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "Please submit the interest form as JSON." }, 415)
  let supplied: unknown
  try {
    supplied = await readJson(request)
  } catch (error) {
    const status = error instanceof BodyError ? error.status : 400
    return json(
      {
        error:
          status === 413
            ? "Your submission is too large."
            : "Please fill out the interest form.",
      },
      status
    )
  }
  const result = validateWaitlistEntry(supplied)
  if (!result.ok) return json({ error: result.error }, 400)
  try {
    await saveWaitlistEntry(result.entry, env.DB)
    return json({ ok: true })
  } catch {
    console.error("Waitlist storage unavailable")
    return json(
      { error: "We couldn't save your details. Please try again in a moment." },
      503
    )
  }
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleWaitlist(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
