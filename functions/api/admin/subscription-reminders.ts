import type { PagesFunction } from "@cloudflare/workers-types"
import {
  authenticateLicenseAdmin,
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
  runSubscriptionReminders,
  subscriptionReminderQueue,
} from "../../../lib/subscription-reminders.ts"

export async function handleAdminReminders(request: Request, env: Env) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  let response: Response
  try {
    if (request.method === "GET")
      response = json(await subscriptionReminderQueue(env))
    else if (request.method === "POST") {
      if (!sameOrigin(request))
        return withAdminSession(
          json({ error: "Invalid request origin." }, 403),
          auth
        )
      const body = await readJson(request)
      if (
        !body ||
        typeof body !== "object" ||
        !("action" in body) ||
        body.action !== "run"
      )
        response = json({ error: "Invalid reminder action." }, 400)
      else
        response = json({
          result: await runSubscriptionReminders(env),
          ...(await subscriptionReminderQueue(env)),
        })
    } else {
      response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
    }
  } catch (error) {
    response =
      error instanceof BodyError
        ? json({ error: "Invalid request." }, error.status)
        : json(
            {
              error:
                "Reminder queue is unavailable. Configure email delivery settings to send reminders.",
            },
            503
          )
  }
  return withAdminSession(response, auth)
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAdminReminders(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
