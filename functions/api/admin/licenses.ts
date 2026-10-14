import type { PagesFunction } from "@cloudflare/workers-types"
import { authenticateLicenseAdmin } from "../../../lib/license-admin-auth.ts"
import {
  BodyError,
  json,
  readJson,
  sameOrigin,
  type Env,
} from "../../../lib/cloudflare.ts"
import {
  changeLicense,
  grantLicense,
  licenseSummary,
  type LicenseRow,
} from "../../../lib/license-store.ts"
import { signingKey } from "../../../lib/license-crypto.ts"

const idPattern = /^[a-f0-9-]{36}$/
export async function handleAdminLicenses(request: Request, env: Env) {
  const auth = await authenticateLicenseAdmin(request, env)
  if (auth instanceof Response) return auth
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
    if (request.method !== "POST") {
      const response = json({ error: "Method not allowed." }, 405)
      response.headers.set("Allow", "GET, POST")
      return response
    }
    if (!sameOrigin(request))
      return json({ error: "Invalid request origin." }, 403)
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return json({ error: "Submit JSON." }, 415)
    let supplied: unknown
    try {
      supplied = await readJson(request)
    } catch (error) {
      return json(
        { error: "Invalid request." },
        error instanceof BodyError ? error.status : 400
      )
    }
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      return json({ error: "Invalid request." }, 400)
    const body = supplied as Record<string, unknown>
    if (body.action === "grant") {
      if (body.type !== "trial" && body.type !== "regular")
        return json({ error: "Choose trial or regular." }, 400)
      if (
        typeof body.customerName !== "string" ||
        !body.customerName.trim() ||
        body.customerName.trim().length > 160 ||
        typeof body.email !== "string" ||
        body.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
        typeof body.notes !== "string" ||
        body.notes.length > 2000
      )
        return json(
          {
            error:
              "Enter a customer name, valid email and notes up to 2,000 characters.",
          },
          400
        )
      // Fail before generating keys customers cannot activate.
      signingKey(env.PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY)
      return json(
        await grantLicense(
          env.DB,
          {
            type: body.type,
            customerName: body.customerName.trim(),
            email: body.email.trim().toLowerCase(),
            notes: body.notes.trim(),
          },
          auth.email
        ),
        201
      )
    }
    if (
      !["revoke", "restore", "set-type", "reset-device"].includes(
        body.action as string
      ) ||
      typeof body.id !== "string" ||
      !idPattern.test(body.id) ||
      (body.action === "set-type" &&
        body.type !== "trial" &&
        body.type !== "regular")
    )
      return json({ error: "Invalid license action." }, 400)
    const license = await changeLicense(
      env.DB,
      body.id,
      body.action as "revoke" | "restore" | "set-type" | "reset-device",
      body.type as "trial" | "regular" | undefined,
      auth.email
    )
    return license
      ? json({ license })
      : json({ error: "License not found." }, 404)
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
