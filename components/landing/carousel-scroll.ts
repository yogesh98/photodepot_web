import { WheelGestures, type WheelEventState } from "wheel-gestures"

const EDGE_TOLERANCE = 2
const SWIPE_THRESHOLD = 48
const WHEEL_THRESHOLD = 12
const WHEEL_IDLE_INTERVAL = 160

export type CarouselScrollAction = "native" | "previous" | "next"

type ScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
}

export function createCarouselWheelController({
  getSection,
  onScroll,
  onNavigate,
}: {
  getSection: () => (ScrollMetrics & { index: number }) | null
  onScroll: (delta: number) => void
  onNavigate: (direction: number) => void
}) {
  const gestures = WheelGestures({
    preventWheelAction: false,
    reverseSign: false,
  })
  let action: CarouselScrollAction | null = null
  let owner = -1
  let direction = 0
  let distance = 0
  let navigated = false
  let lastWheelAt = -Infinity

  function handleGesture(state: WheelEventState) {
    if (state.isEnding) {
      action = null
      return
    }
    const [horizontal, delta] = state.axisDelta
    if (!delta || Math.abs(horizontal) > Math.abs(delta)) return
    const section = getSection()
    if (!section) return
    const nextDirection = Math.sign(delta)
    // Sparse mouse-wheel ticks may end before the classifier has enough
    // samples. Trackpad renewals also use isStart, even without a quiet gap.
    const idle = state.event.timeStamp - lastWheelAt > WHEEL_IDLE_INTERVAL
    lastWheelAt = state.event.timeStamp
    if (
      state.isStart ||
      action === null ||
      (!state.isMomentum && (idle || nextDirection !== direction))
    ) {
      action = getCarouselScrollAction({ ...section, delta })
      owner = section.index
      direction = nextDirection
      distance = 0
      navigated = false
    }

    // A gesture belongs to the section where it started. Its momentum may
    // finish reading that section, but cannot scroll or skip the next one.
    if (navigated || section.index !== owner) return
    if (action === "native") {
      onScroll(delta)
      return
    }
    distance += delta
    if (Math.abs(distance) < WHEEL_THRESHOLD || state.isMomentum) return
    navigated = true
    onNavigate(direction)
  }

  gestures.on("wheel", handleGesture)
  return {
    feedWheel: gestures.feedWheel,
    destroy() {
      gestures.off("wheel", handleGesture)
      gestures.disconnect()
    },
  }
}

export function getCarouselScrollAction({
  scrollTop,
  scrollHeight,
  viewportHeight,
  delta,
}: ScrollMetrics & { delta: number }): CarouselScrollAction {
  if (delta === 0) return "native"

  const maximumScrollTop = Math.max(0, scrollHeight - viewportHeight)
  const position = Math.min(maximumScrollTop, Math.max(0, scrollTop))

  if (delta > 0) {
    return maximumScrollTop - position > EDGE_TOLERANCE ? "native" : "next"
  }

  return position > EDGE_TOLERANCE ? "native" : "previous"
}

export function getCarouselSwipeAction({
  startX,
  startY,
  endX,
  endY,
  ...startScrollMetrics
}: ScrollMetrics & {
  startX: number
  startY: number
  endX: number
  endY: number
}): CarouselScrollAction {
  const delta = startY - endY
  const horizontalDistance = Math.abs(startX - endX)

  if (
    Math.abs(delta) < SWIPE_THRESHOLD ||
    Math.abs(delta) <= horizontalDistance
  ) {
    return "native"
  }

  // Use the position at touch start so a swipe can finish reading a section
  // without also advancing past it in the same gesture.
  return getCarouselScrollAction({ ...startScrollMetrics, delta })
}

export function getCarouselEntryScrollTop({
  scrollHeight,
  viewportHeight,
  direction,
}: {
  scrollHeight: number
  viewportHeight: number
  direction: number
}): number {
  return direction < 0 ? Math.max(0, scrollHeight - viewportHeight) : 0
}
