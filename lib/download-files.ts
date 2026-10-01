import { open, stat } from "node:fs/promises"
import { join, posix } from "node:path"
import { Readable } from "node:stream"
import type { Architecture } from "./download-auth"

export const DOWNLOAD_FILES: Record<Architecture, string> = {
  arm64: "photodepot-0.1.0-arm64.dmg",
  x64: "photodepot-0.1.0-x64.dmg",
}

export function downloadPath(architecture: Architecture) {
  return join(
    process.cwd(),
    "public",
    "downloads",
    DOWNLOAD_FILES[architecture]
  )
}

export async function downloadExists(architecture: Architecture) {
  try {
    const file = await stat(downloadPath(architecture))
    return file.isFile() && file.size > 0
  } catch {
    return false
  }
}

export async function openDownload(architecture: Architecture) {
  const file = await open(downloadPath(architecture), "r")
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size === 0)
      throw new Error("Installer unavailable")
    return {
      name: DOWNLOAD_FILES[architecture],
      size: info.size,
      stream: Readable.toWeb(file.createReadStream(), {
        strategy: {
          highWaterMark: 64 * 1024,
          size: (chunk: Uint8Array) => chunk.byteLength,
        },
      }) as ReadableStream<Uint8Array>,
    }
  } catch (error) {
    await file.close()
    throw error
  }
}

// Public files must only be delivered through the authenticated API. Decode and
// normalize here so encoded folder names and traversal cannot bypass the guard.
export function isDownloadAsset(pathname: string) {
  try {
    const path = posix
      .normalize(decodeURIComponent(pathname).replaceAll("\\", "/"))
      .toLowerCase()
    return path === "/downloads" || path.startsWith("/downloads/")
  } catch {
    return true
  }
}
