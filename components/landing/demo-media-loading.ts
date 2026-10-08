import { useSyncExternalStore } from "react"

const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia(reducedMotionQuery)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

export function useDemoReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true
  )
}

// Share the small compressed files between preloading and video playback.
// Blob URLs live for this page so returning to a tab needs no second download.
const videoLoads = new Map<string, Promise<string | null>>()

export function prefersSaveData() {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection
  return connection?.saveData === true
}

export function preloadDemoVideo(
  src: string,
  priority: "low" | "auto" = "low"
): Promise<string | null> {
  if (
    typeof window === "undefined" ||
    window.matchMedia(reducedMotionQuery).matches
  ) {
    return Promise.resolve(null)
  }

  const existing = videoLoads.get(src)
  if (existing) return existing

  const promise = fetch(src, { priority })
    .then(async (response) => {
      if (!response.ok) throw new Error("Demo download failed")
      return URL.createObjectURL(await response.blob())
    })
    .catch(() => {
      videoLoads.delete(src)
      return null
    })
  videoLoads.set(src, promise)
  return promise
}

export function warmDemoVideo(src: string) {
  if (!prefersSaveData()) void preloadDemoVideo(src)
}
