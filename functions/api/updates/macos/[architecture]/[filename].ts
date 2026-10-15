import type { PagesFunction } from "@cloudflare/workers-types"
import { downloadRange } from "../../../../../lib/download-files.ts"
import {
  UPDATE_ARTIFACT_CACHE,
  UPDATE_FEED_CACHE,
  updateObjectKey,
} from "../../../../../lib/update-files.ts"
import { json, type Env } from "../../../../../lib/cloudflare.ts"

export async function handleUpdate(
  request: Request,
  env: Env,
  architecture: string,
  filename: string
) {
  const key = updateObjectKey(architecture, filename)
  if (!key) return failure(request, 404, "Unknown update.")
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = failure(request, 405, "Method not allowed.")
    response.headers.set("Allow", "GET, HEAD")
    return response
  }
  try {
    const metadata = await env.DOWNLOADS.head(key)
    if (!metadata || metadata.size === 0)
      return failure(request, 404, "Update unavailable.")
    const headers = new Headers({
      "Cache-Control":
        filename === "latest-mac.yml"
          ? UPDATE_FEED_CACHE
          : UPDATE_ARTIFACT_CACHE,
      "Content-Type":
        filename === "latest-mac.yml"
          ? "application/yaml; charset=utf-8"
          : "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Accept-Ranges": "bytes",
      ETag: metadata.httpEtag,
      "Last-Modified": metadata.uploaded.toUTCString(),
      "Content-Length": String(metadata.size),
    })
    const ifNoneMatch = request.headers.get("if-none-match")
    if (
      ifNoneMatch?.split(",").some((value) => {
        const tag = value.trim().replace(/^W\//, "")
        return tag === "*" || tag === metadata.httpEtag
      })
    ) {
      headers.delete("Content-Length")
      return new Response(null, { status: 304, headers })
    }
    if (request.method === "HEAD") return new Response(null, { headers })
    // Only strong ETags authorize a range. Date validators conservatively get
    // the full representation, avoiding second-resolution upload ambiguity.
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
    const object = await env.DOWNLOADS.get(key, {
      ...(range ? { range } : {}),
      onlyIf: { etagMatches: metadata.etag },
    })
    // A feed can change between head/get; retry later instead of serving a body
    // with metadata (or range offsets) belonging to another object version.
    if (!object || !("body" in object))
      return failure(request, 503, "Update storage changed. Retry later.")
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
    return failure(request, 503, "Update storage unavailable. Retry later.")
  }
}

function failure(request: Request, status: number, error: string) {
  const response = json({ error }, status)
  return request.method === "HEAD"
    ? new Response(null, { status, headers: response.headers })
    : response
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleUpdate(
    context.request as unknown as Request,
    context.env,
    String(context.params.architecture),
    String(context.params.filename)
  ) as unknown as ReturnType<PagesFunction<Env>>
