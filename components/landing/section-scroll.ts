const EDGE_TOLERANCE = 2

export function getSectionWheelAction({
  scrollTop,
  delta,
  viewportHeight,
  sectionStart,
  sectionEnd,
}: {
  scrollTop: number
  delta: number
  viewportHeight: number
  sectionStart: number
  sectionEnd: number
}): { type: "native" | "navigate" } | { type: "edge"; top: number } {
  const edge =
    delta > 0
      ? Math.max(sectionStart, sectionEnd - viewportHeight)
      : sectionStart
  const remaining = (edge - scrollTop) * Math.sign(delta)

  if (remaining <= EDGE_TOLERANCE) return { type: "navigate" }
  if (Math.abs(delta) < remaining) return { type: "native" }
  return { type: "edge", top: edge }
}

export function getSectionEntryPosition({
  sectionStart,
  sectionEnd,
  viewportHeight,
  direction,
}: {
  sectionStart: number
  sectionEnd: number
  viewportHeight: number
  direction: number
}) {
  return direction < 0
    ? Math.max(sectionStart, sectionEnd - viewportHeight)
    : sectionStart
}
