import { NextRequest, NextResponse } from "next/server"
import { isDownloadAsset } from "@/lib/download-files"

export function proxy(request: NextRequest) {
  if (isDownloadAsset(request.nextUrl.pathname)) {
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    })
  }
  return NextResponse.next()
}
