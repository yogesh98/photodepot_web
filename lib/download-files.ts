export type Architecture = "arm64" | "x64"

// Publish both architectures together after their signed release is uploaded.
export const DOWNLOADS_ENABLED = true

export function isArchitecture(value: string): value is Architecture {
  return value === "arm64" || value === "x64"
}

// Versioned R2 object keys, shared by the API and release upload script.
export const DOWNLOAD_FILES: Record<Architecture, string> = {
  arm64: "photodepot-0.2.1-arm64.dmg",
  x64: "photodepot-0.2.1-x64.dmg",
}

export function downloadRange(header: string | null, size: number) {
  if (!header || header.includes(",")) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }
  const offset = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    offset >= size ||
    end < offset
  )
    return false
  return { offset, length: Math.min(end, size - 1) - offset + 1 }
}
