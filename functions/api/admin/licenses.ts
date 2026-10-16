import type { PagesFunction } from "@cloudflare/workers-types"
import {
  authenticateLicenseAdmin,
  withAdminSession,
} from "../../../lib/license-admin-auth.ts"
import { json, sameOrigin, type Env } from "../../../lib/cloudflare.ts"
import { licenseSummary, type LicenseRow } from "../../../lib/license-store.ts"
import { updateRequired } from "../../../lib/license-api.ts"

const idPattern = /^[a-f0-9-]{36}$/
export async function handleAdminLicenses(request: Request, env: Env) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
  return withAdminSession(
    await handleAuthorizedAdminLicenses(request, env),
    auth
  )
}
async function handleAuthorizedAdminLicenses(request: Request, env: Env) {
  try {
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams
      const id = query.get("id")
      if (id) {
        if (!idPattern.test(id)) return json({ error: "Invalid license." }, 400)
        const rows = await env.DB.prepare(
          "SELECT id, action, actor, created_at AS createdAt, detail FROM license_audit WHERE license_id = ? ORDER BY created_at DESC, id DESC LIMIT 50"
        )
          .bind(id)
          .all()
        return json({ audit: rows.results })
      }
      const cursor = query.get("cursor")
      let position: { createdAt: number; id: string } | null = null
      if (cursor) {
        try {
          position = JSON.parse(Buffer.from(cursor, "base64url").toString())
        } catch {
          return json({ error: "Invalid page." }, 400)
        }
        if (
          !position ||
          !Number.isSafeInteger(position.createdAt) ||
          !idPattern.test(position.id)
        )
          return json({ error: "Invalid page." }, 400)
      }
      const statement = position
        ? env.DB.prepare(
            "SELECT * FROM licenses WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT 101"
          ).bind(position.createdAt, position.createdAt, position.id)
        : env.DB.prepare(
            "SELECT * FROM licenses ORDER BY created_at DESC, id DESC LIMIT 101"
          )
      const results = await statement.all<LicenseRow>()
      const rows = results.results.slice(0, 100)
      const last = rows.at(-1)
      return json({
        licenses: rows.map(licenseSummary),
        nextCursor:
          results.results.length > 100 && last
            ? Buffer.from(
                JSON.stringify({ createdAt: last.created_at, id: last.id })
              ).toString("base64url")
            : null,
      })
    }
    if (!sameOrigin(request))
      return json({ error: "Invalid request origin." }, 403)
    return updateRequired()
  } catch {
    console.error("License administration service unavailable")
    return json(
      {
        error:
          "License administration is temporarily unavailable. Please try again.",
      },
      503
    )
  }
}
export const onRequest: PagesFunction<Env> = (context) =>
  handleAdminLicenses(
    context.request as unknown as Request,
    context.env
  ) as unknown as ReturnType<PagesFunction<Env>>
