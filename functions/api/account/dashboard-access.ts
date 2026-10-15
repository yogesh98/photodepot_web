import type { PagesFunction } from "@cloudflare/workers-types"
import { json, type Env } from "../../../lib/cloudflare.ts"
import {
  accountCanAccessLicenseAdmin,
  authenticateLicenseAdmin,
  authenticateWorkOSAccount,
  withAdminSession,
} from "../../../lib/license-admin-auth.ts"

export async function handleDashboardAccess(request: Request, env: Env) {
  if (request.method !== "GET") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "GET")
    return response
  }
  const dashboard =
    new URL(request.url).searchParams.get("dashboard") ?? "individual"
  if (!["admin", "individual"].includes(dashboard))
    return json({ error: "Choose a dashboard." }, 400)
  const auth = await (dashboard === "admin"
    ? authenticateLicenseAdmin(request, env)
    : authenticateWorkOSAccount(request, env))
  if (auth instanceof Response) return auth
  return withAdminSession(
    json({
      user: { id: auth.userId, email: auth.email },
      canAccessAdmin:
        dashboard === "admin" ||
        (await accountCanAccessLicenseAdmin(auth, env)),
    }),
    auth
  )
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleDashboardAccess(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
