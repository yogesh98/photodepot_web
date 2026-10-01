import { NextRequest, NextResponse } from "next/server"
import {
  ACCESS_COOKIE,
  ACCESS_SECONDS,
  allowPasswordAttempt,
  createAccessToken,
  hasDownloadAccess,
  isArchitecture,
  passwordsMatch,
} from "@/lib/download-auth"
import { downloadExists, openDownload } from "@/lib/download-files"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ architecture: string }> }
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
}

function error(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: privateHeaders }
  )
}

export async function POST(request: NextRequest, context: Context) {
  const { architecture } = await context.params
  if (!isArchitecture(architecture)) return error("Unknown download.", 404)
  // Only same-origin JSON requests may issue an access cookie.
  // NextURL normalizes 127.0.0.1 to localhost; preserve the incoming Host.
  const requestOrigin = `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`
  if (
    request.headers.get("origin") !== requestOrigin ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    return error("Invalid request.", 403)
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  if (!allowPasswordAttempt(ip)) {
    const response = error(
      "Too many attempts. Please try again in 10 minutes.",
      429
    )
    response.headers.set("Retry-After", "600")
    return response
  }
  const password = process.env.PHOTODEPOT_DOWNLOAD_PASSWORD
  if (!password)
    return error("Downloads aren't available yet. Please check back soon.", 503)
  let supplied: unknown
  try {
    const reader = request.body?.getReader()
    if (!reader) return error("Invalid request.", 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) {
        await reader.cancel()
        return error("Invalid request.", 413)
      }
      chunks.push(value)
    }
    supplied = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.password
  } catch {
    return error("Invalid request.", 400)
  }
  if (typeof supplied !== "string" || !passwordsMatch(supplied, password))
    return error("That password doesn't match. Please try again.", 401)
  if (!(await downloadExists(architecture)))
    return error("This build isn't available yet. Please check back soon.", 503)
  const response = NextResponse.json({ ok: true }, { headers: privateHeaders })
  response.cookies.set(
    ACCESS_COOKIE,
    createAccessToken(architecture, password),
    {
      httpOnly: true,
      // Next derives the protocol from X-Forwarded-Proto behind a reverse proxy.
      secure: request.nextUrl.protocol === "https:",
      sameSite: "strict",
      path: `/api/download/${architecture}`,
      maxAge: ACCESS_SECONDS,
    }
  )
  return response
}

export async function GET(request: NextRequest, context: Context) {
  const { architecture } = await context.params
  if (!isArchitecture(architecture)) return error("Unknown download.", 404)
  function back(reason: string) {
    const requestOrigin = `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`
    return NextResponse.redirect(
      new URL(`/tester?download=${reason}`, requestOrigin),
      {
        status: 303,
        headers: privateHeaders,
      }
    )
  }
  if (
    !hasDownloadAccess(
      request.cookies.get(ACCESS_COOKIE)?.value,
      architecture,
      process.env.PHOTODEPOT_DOWNLOAD_PASSWORD || ""
    )
  )
    return back("locked")
  try {
    const file = await openDownload(architecture)
    const headers = new Headers(privateHeaders)
    headers.set("Content-Type", "application/octet-stream")
    headers.set("Content-Disposition", `attachment; filename="${file.name}"`)
    headers.set("Content-Length", String(file.size))
    headers.set("X-Content-Type-Options", "nosniff")
    return new Response(file.stream, { headers })
  } catch {
    return back("unavailable")
  }
}
