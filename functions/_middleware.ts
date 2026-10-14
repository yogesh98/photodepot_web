import type { PagesFunction } from "@cloudflare/workers-types"
import type { Env } from "../lib/cloudflare.ts"
import { authenticateLicenseAdmin } from "../lib/license-admin-auth.ts"

// Also protects the shell on pages.dev, preview deployments and direct .html URLs.
export const onRequest: PagesFunction<Env> = async (context) => {
  const path = new URL(context.request.url).pathname
  if (path === "/admin" || path.startsWith("/admin/")) {
    const auth = await authenticateLicenseAdmin(
      context.request as unknown as Request,
      context.env
    )
    if (auth instanceof Response)
      return auth as unknown as Awaited<ReturnType<PagesFunction<Env>>>
  }
  const response = await context.next()
  if (path === "/admin" || path.startsWith("/admin/")) {
    response.headers.set("Cache-Control", "private, no-store")
    response.headers.set("X-Robots-Tag", "noindex, nofollow")
    response.headers.set("Referrer-Policy", "no-referrer")
  }
  return response
}
