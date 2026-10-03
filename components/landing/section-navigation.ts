export type SectionBounds = { top: number; height: number }

const BOUNDARY_TOLERANCE = 2

export function getSectionIndex(sections: SectionBounds[], scrollTop: number) {
  return Math.max(
    0,
    sections.findLastIndex(
      (section) => section.top <= scrollTop + BOUNDARY_TOLERANCE
    )
  )
}

export function getSectionNavigation(
  sections: SectionBounds[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
  direction: number
) {
  const section = sections[index]
  const bottom = section.top + Math.max(0, section.height - viewportHeight)
  const boundary = direction > 0 ? bottom : section.top
  const canScroll =
    direction > 0
      ? scrollTop < boundary - BOUNDARY_TOLERANCE
      : scrollTop > boundary + BOUNDARY_TOLERANCE
  const adjacent = sections[index + direction]
  // Enter a taller previous section at its bottom so its content stays readable
  // in either direction. Forward navigation always enters at the top.
  const target = adjacent
    ? adjacent.top +
      (direction < 0 ? Math.max(0, adjacent.height - viewportHeight) : 0)
    : null

  return { boundary, canScroll, target }
}

export function getSectionSettlement(
  sections: SectionBounds[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
  direction: number
) {
  const section = sections[index]
  const bottom = section.top + Math.max(0, section.height - viewportHeight)
  // A native swipe can reverse while the viewport straddles two sections.
  // Bring the original section fully back into view when returning to it.
  if (direction < 0 && scrollTop > bottom + BOUNDARY_TOLERANCE) return bottom
  if (direction > 0 && scrollTop < section.top - BOUNDARY_TOLERANCE) {
    return section.top
  }
  const { canScroll, target } = getSectionNavigation(
    sections,
    index,
    scrollTop,
    viewportHeight,
    direction
  )
  return canScroll ? null : target
}
