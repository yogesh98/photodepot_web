import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../lib/cloudflare.ts"
import {
  authenticateLicenseAdmin,
  adminAuthPage,
  withAdminSession,
  type AdminAuth,
} from "../lib/license-admin-auth.ts"

// Also protects the shell on pages.dev, preview deployments and direct .html URLs.
export const onRequest: PagesFunction<Env> = async (context) => {
  const path = new URL(context.request.url).pathname
  let adminAuth: AdminAuth | undefined
  if (path === "/admin" || path.startsWith("/admin/")) {
    const auth = await authenticateLicenseAdmin(
      context.request as unknown as Request,
      context.env
    )
    if (auth instanceof Response) {
      if (
        auth.status === 401 &&
        ["GET", "HEAD"].includes(context.request.method)
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/api/auth/login",
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow",
          },
        }) as unknown as Awaited<ReturnType<PagesFunction<Env>>>
      }
      return adminAuthPage(auth) as unknown as Awaited<
        ReturnType<PagesFunction<Env>>
      >
    }
    adminAuth = auth
  }
  const response = await context.next()
  if (path === "/admin" || path.startsWith("/admin/")) {
    response.headers.set("Cache-Control", "private, no-store")
    response.headers.set("X-Robots-Tag", "noindex, nofollow")
    // Native POST forms need their same-origin Origin header for CSRF checks.
    // External navigations still receive no referrer with this policy.
    response.headers.set("Referrer-Policy", "same-origin")
    if (adminAuth) withAdminSession(response as unknown as Response, adminAuth)
  }
  return response
}
