import type { D1Database, R2Bucket } from "@cloudflare/workers-types"

export interface Env {
  DOWNLOADS: R2Bucket
  DB: D1Database
  PHOTODEPOT_LICENSE_SIGNING_PRIVATE_KEY?: string
  WORKOS_CLIENT_ID?: string
  WORKOS_API_KEY?: string
  WORKOS_ADMIN_ORGANIZATION_ID?: string
  WORKOS_COOKIE_PASSWORD?: string
  WORKOS_REDIRECT_URI?: string
  WORKOS_WEBHOOK_SECRET?: string
  PHOTODEPOT_ENVIRONMENT?: string
}

export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
}

export function json(body: object, status = 200) {
  return Response.json(body, { status, headers: privateHeaders })
}

export class BodyError extends Error {
  status: number
  constructor(status: number) {
    super("Invalid request body")
    this.status = status
  }
}

export async function readText(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new BodyError(400)
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) {
        await reader.cancel()
        throw new BodyError(413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    )
  } catch (error) {
    throw error instanceof BodyError ? error : new BodyError(400)
  } finally {
    reader.releaseLock()
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await readText(request)) as unknown
  } catch (error) {
    throw error instanceof BodyError ? error : new BodyError(400)
  }
}

export function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(request.url).origin
}
