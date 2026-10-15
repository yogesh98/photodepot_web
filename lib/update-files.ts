import { isArchitecture } from "./download-files.ts"

// Stable releases use one feed per architecture. Historical ZIPs and blockmaps
// stay addressable for differential updates from older installed versions.
const stableVersion = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)"

export function updateObjectKey(architecture: string, filename: string) {
  if (!isArchitecture(architecture)) return null
  if (
    filename !== "latest-mac.yml" &&
    !new RegExp(
      `^photodepot-${stableVersion}-${architecture}\\.zip(?:\\.blockmap)?$`
    ).test(filename)
  )
    return null
  return `updates/macos/${architecture}/${filename}`
}

export function isStableVersion(version: unknown): version is string {
  return (
    typeof version === "string" &&
    new RegExp(`^${stableVersion}$`).test(version)
  )
}

export const UPDATE_FEED_CACHE = "no-store"
export const UPDATE_ARTIFACT_CACHE = "public, max-age=31536000, immutable"
