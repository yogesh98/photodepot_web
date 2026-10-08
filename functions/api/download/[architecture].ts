import type { PagesFunction } from "@cloudflare/workers-types"
import {
  ACCESS_COOKIE,
  ACCESS_SECONDS,
  createAccessToken,
  hasDownloadAccess,
  isArchitecture,
  passwordsMatch,
} from "../../../lib/download-auth.ts"
import { DOWNLOAD_FILES, downloadRange } from "../../../lib/download-files.ts"
import { allowPasswordAttempt } from "../../../lib/download-rate-limit.ts"
import {
  BodyError,
  cookieValue,
  json,
  privateHeaders,
  readJson,
  sameOrigin,
  type Env,
} from "../../../lib/cloudflare.ts"

export async function handleDownload(
  request: Request,
  env: Env,
  architecture: string
) {
  if (!isArchitecture(architecture))
    return json({ error: "Unknown download." }, 404)
  const password = env.PHOTODEPOT_DOWNLOAD_PASSWORD || ""
  const name = DOWNLOAD_FILES[architecture]
  const url = new URL(request.url)
  const back = (reason: string) =>
    new Response(null, {
      status: 303,
      headers: {
        ...privateHeaders,
        Location: new URL(`/tester?download=${reason}`, url).href,
      },
    })

  if (request.method === "POST") {
    if (
      !sameOrigin(request) ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return json({ error: "Invalid request." }, 403)
    if (!password || !env.DB || !env.DOWNLOADS)
      return json(
        { error: "Downloads aren't available yet. Please check back soon." },
        503
      )
    try {
      // Cloudflare supplies this header. Ignore client-supplied forwarded IPs.
      const ip = request.headers.get("cf-connecting-ip") || "local"
      if (!(await allowPasswordAttempt(env.DB, ip, password))) {
        const response = json(
          { error: "Too many attempts. Please try again in 10 minutes." },
          429
        )
        response.headers.set("Retry-After", "600")
        return response
      }
      const body = await readJson(request)
      const supplied =
        body && typeof body === "object" && "password" in body
          ? body.password
          : undefined
      if (typeof supplied !== "string" || !passwordsMatch(supplied, password))
        return json(
          { error: "That password doesn't match. Please try again." },
          401
        )
      const object = await env.DOWNLOADS.head(name)
      if (!object || object.size === 0)
        return json(
          { error: "This build isn't available yet. Please check back soon." },
          503
        )
      const secure = url.protocol === "https:" ? "; Secure" : ""
      const cookie = `${ACCESS_COOKIE}=${createAccessToken(architecture, password)}; HttpOnly; SameSite=Strict; Path=/api/download/${architecture}; Max-Age=${ACCESS_SECONDS}${secure}`
      const response = json({ ok: true })
      response.headers.set("Set-Cookie", cookie)
      return response
    } catch (error) {
      if (error instanceof BodyError)
        return json({ error: "Invalid request." }, error.status)
      console.error("Download authorization storage unavailable")
      return json(
        { error: "Downloads aren't available yet. Please check back soon." },
        503
      )
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "GET, HEAD, POST")
    return response
  }
  if (
    !hasDownloadAccess(
      cookieValue(request, ACCESS_COOKIE),
      architecture,
      password
    )
  )
    return back("locked")
  try {
    const metadata = await env.DOWNLOADS.head(name)
    if (!metadata || metadata.size === 0) return back("unavailable")
    const headers = new Headers(privateHeaders)
    headers.set("Content-Type", "application/octet-stream")
    headers.set("Content-Disposition", `attachment; filename="${name}"`)
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Accept-Ranges", "bytes")
    headers.set("ETag", metadata.httpEtag)
    headers.set("Content-Length", String(metadata.size))
    if (request.method === "HEAD") return new Response(null, { headers })
    const ifRange = request.headers.get("if-range")
    const range = downloadRange(
      !ifRange || ifRange === metadata.httpEtag
        ? request.headers.get("range")
        : null,
      metadata.size
    )
    if (range === false) {
      headers.delete("Content-Length")
      headers.set("Content-Range", `bytes */${metadata.size}`)
      return new Response(null, { status: 416, headers })
    }
    // Pin the body to the metadata's version, so replacing a release mid-request
    // cannot send inconsistent Content-Length or range headers.
    const object = await env.DOWNLOADS.get(name, {
      ...(range ? { range } : {}),
      onlyIf: { etagMatches: metadata.etag },
    })
    if (!object || !("body" in object)) return back("unavailable")
    if (range) {
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`
      )
      headers.set("Content-Length", String(range.length))
    }
    return new Response(object.body as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    })
  } catch {
    return back("unavailable")
  }
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleDownload(
    context.request as unknown as Request,
    context.env,
    String(context.params.architecture)
  ) as unknown as ReturnType<PagesFunction<Env>>
