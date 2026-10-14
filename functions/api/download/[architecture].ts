import type { PagesFunction } from "@cloudflare/workers-types"
import {
  DOWNLOAD_FILES,
  downloadRange,
  isArchitecture,
} from "../../../lib/download-files.ts"
import { json, privateHeaders, type Env } from "../../../lib/cloudflare.ts"

export async function handleDownload(
  request: Request,
  env: Env,
  architecture: string
) {
  if (!isArchitecture(architecture))
    return json({ error: "Unknown download." }, 404)
  const name = DOWNLOAD_FILES[architecture]
  const url = new URL(request.url)
  const unavailable = () =>
    new Response(null, {
      status: 303,
      headers: {
        ...privateHeaders,
        Location: new URL("/tester?download=unavailable", url).href,
      },
    })

  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = json({ error: "Method not allowed." }, 405)
    response.headers.set("Allow", "GET, HEAD")
    return response
  }
  try {
    const metadata = await env.DOWNLOADS.head(name)
    if (!metadata || metadata.size === 0) return unavailable()
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
    if (!object || !("body" in object)) return unavailable()
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
    return unavailable()
  }
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleDownload(
    context.request as unknown as Request,
    context.env,
    String(context.params.architecture)
  ) as unknown as ReturnType<PagesFunction<Env>>
