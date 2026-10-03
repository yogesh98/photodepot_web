import assert from "node:assert/strict"
import { test } from "node:test"
import { createCarouselTouchController } from "../components/landing/carousel-scroll.ts"

const fittedSection = {
  index: 0,
  scrollTop: 0,
  scrollHeight: 600,
  viewportHeight: 600,
}
const tallSection = {
  index: 3,
  scrollTop: 500,
  scrollHeight: 1200,
  viewportHeight: 600,
}

function setup(initial = fittedSection) {
  let section = { ...initial }
  const navigations = []
  const controller = createCarouselTouchController({
    getSection: () => (section ? { ...section } : null),
    onNavigate: (direction) => navigations.push(direction),
  })
  return {
    controller,
    navigations,
    updateSection(update) {
      section = section ? { ...section, ...update } : update
    },
    removeSection() {
      section = null
    },
  }
}

test("a short deliberate boundary swipe navigates before the finger lifts", () => {
  for (const direction of [1, -1]) {
    const { controller, navigations } = setup()
    controller.start({ x: 100, y: 300 })
    controller.move({ x: 100, y: 300 - direction * 23 })
    assert.deepEqual(navigations, [])
    controller.move({ x: 100, y: 300 - direction * 24 })
    assert.deepEqual(navigations, [direction])
  }
})

test("reading a tall section stays native despite a long finger movement", () => {
  const { controller, navigations, updateSection } = setup(tallSection)
  controller.start({ x: 100, y: 500 })
  updateSection({ scrollTop: 550 })
  controller.move({ x: 100, y: 300 })
  controller.end({ x: 100, y: 150 })
  assert.deepEqual(navigations, [])
})

test("the same swipe can continue outward after reaching a live bottom edge", () => {
  const { controller, navigations, updateSection } = setup(tallSection)
  controller.start({ x: 100, y: 500 })
  updateSection({ scrollTop: 550 })
  controller.move({ x: 100, y: 400 })
  updateSection({ scrollTop: 600 })
  controller.move({ x: 100, y: 300 })
  assert.deepEqual(navigations, [])
  controller.move({ x: 100, y: 277 })
  assert.deepEqual(navigations, [])
  controller.move({ x: 100, y: 276 })
  assert.deepEqual(navigations, [1])
})

test("the same swipe can continue outward after reaching a live top edge", () => {
  const { controller, navigations, updateSection } = setup({
    ...tallSection,
    scrollTop: 100,
  })
  controller.start({ x: 100, y: 100 })
  updateSection({ scrollTop: 50 })
  controller.move({ x: 100, y: 150 })
  updateSection({ scrollTop: 0 })
  controller.move({ x: 100, y: 200 })
  assert.deepEqual(navigations, [])
  controller.move({ x: 100, y: 224 })
  assert.deepEqual(navigations, [-1])
})

test("revealing the bottom does not skip the newly visible content on release", () => {
  const { controller, navigations, updateSection } = setup(tallSection)
  controller.start({ x: 100, y: 500 })
  updateSection({ scrollTop: 600 })
  controller.move({ x: 100, y: 100 })
  controller.end({ x: 100, y: 100 })
  assert.deepEqual(navigations, [])
})

test("a sparse interior swipe ending at the bottom does not advance", () => {
  const { controller, navigations, updateSection } = setup(tallSection)
  controller.start({ x: 100, y: 500 })
  updateSection({ scrollTop: 600 })
  controller.end({ x: 100, y: 100 })
  assert.deepEqual(navigations, [])
})

test("a sparse boundary swipe can navigate on touchend without touchmove", () => {
  for (const direction of [1, -1]) {
    const { controller, navigations } = setup()
    controller.start({ x: 100, y: 300 })
    controller.end({ x: 100, y: 300 - direction * 24 })
    assert.deepEqual(navigations, [direction])
  }
})

test("reversing direction requires a fresh outward movement from the reversal", () => {
  const { controller, navigations } = setup()
  controller.start({ x: 100, y: 300 })
  controller.move({ x: 100, y: 280 })
  controller.move({ x: 100, y: 289 })
  controller.move({ x: 100, y: 312 })
  assert.deepEqual(navigations, [])
  controller.move({ x: 100, y: 313 })
  assert.deepEqual(navigations, [-1])
})

test("moving back into readable content resets the outward edge movement", () => {
  const { controller, navigations, updateSection } = setup({
    ...tallSection,
    scrollTop: 600,
  })
  controller.start({ x: 100, y: 300 })
  controller.move({ x: 100, y: 280 })
  updateSection({ scrollTop: 590 })
  controller.move({ x: 100, y: 290 })
  updateSection({ scrollTop: 600 })
  controller.move({ x: 100, y: 270 })
  assert.deepEqual(navigations, [])
  controller.move({ x: 100, y: 247 })
  assert.deepEqual(navigations, [])
  controller.move({ x: 100, y: 246 })
  assert.deepEqual(navigations, [1])
})

test("one physical swipe advances only once even if further events arrive", () => {
  const { controller, navigations } = setup()
  controller.start({ x: 100, y: 500 })
  controller.move({ x: 100, y: 470 })
  controller.move({ x: 100, y: 350 })
  controller.end({ x: 100, y: 100 })
  assert.deepEqual(navigations, [1])
  controller.start({ x: 100, y: 300 })
  controller.end({ x: 100, y: 270 })
  assert.deepEqual(navigations, [1, 1])
})

test("changing the selected section cancels the old section's touch session", () => {
  const { controller, navigations, updateSection } = setup()
  controller.start({ x: 100, y: 300 })
  updateSection({ index: 1 })
  controller.move({ x: 100, y: 280 })
  updateSection({ index: 0 })
  controller.end({ x: 100, y: 200 })
  assert.deepEqual(navigations, [])
})

test("losing the current section cancels a touch session", () => {
  const { controller, navigations, removeSection, updateSection } = setup()
  controller.start({ x: 100, y: 300 })
  removeSection()
  controller.move({ x: 100, y: 280 })
  updateSection(fittedSection)
  controller.end({ x: 100, y: 200 })
  assert.deepEqual(navigations, [])
})

test("cancel prevents release navigation and permits the next gesture", () => {
  const { controller, navigations } = setup()
  controller.start({ x: 100, y: 300 })
  controller.move({ x: 100, y: 280 })
  controller.cancel()
  controller.end({ x: 100, y: 200 })
  assert.deepEqual(navigations, [])
  controller.start({ x: 100, y: 300 })
  controller.end({ x: 100, y: 276 })
  assert.deepEqual(navigations, [1])
})

test("taps, horizontal movements, and equal diagonals do not navigate", () => {
  for (const point of [
    { x: 100, y: 300 },
    { x: 100, y: 277 },
    { x: 140, y: 270 },
    { x: 130, y: 270 },
    { x: 70, y: 330 },
  ]) {
    const { controller, navigations } = setup()
    controller.start({ x: 100, y: 300 })
    controller.move(point)
    controller.end(point)
    assert.deepEqual(navigations, [], JSON.stringify(point))
  }
})
