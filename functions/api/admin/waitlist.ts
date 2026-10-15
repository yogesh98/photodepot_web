import type { PagesFunction } from "@cloudflare/workers-types"
import {
  authenticateLicenseAdmin,
  withAdminSession,
} from "../../../lib/license-admin-auth.ts"
import { json, type Env } from "../../../lib/cloudflare.ts"
import { listAdminWaitlist } from "../../../lib/admin-waitlist.ts"

export async function handleAdminWaitlist(request: Request, env: Env) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  try {
    if (request.method !== "GET") {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET")
      return withAdminSession(response, auth)
    }
    return withAdminSession(
      json(await listAdminWaitlist(env.DB, new URL(request.url).searchParams)),
      auth
    )
  } catch (error) {
    return withAdminSession(
      json(
        {
          error:
            error instanceof TypeError
              ? error.message
              : "The waitlist is temporarily unavailable. Please try again.",
        },
        error instanceof TypeError ? 400 : 503
      ),
      auth
    )
  }
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAdminWaitlist(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
