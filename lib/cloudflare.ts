import type { D1Database, R2Bucket } from "@cloudflare/workers-types"

export interface Env {
  DOWNLOADS: R2Bucket
  DB: D1Database
  PHOTODEPOT_DOWNLOAD_PASSWORD?: string
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

export async function readJson(request: Request) {
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
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw error instanceof BodyError ? error : new BodyError(400)
  } finally {
    reader.releaseLock()
  }
}

export function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(request.url).origin
}

export function cookieValue(request: Request, name: string) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
