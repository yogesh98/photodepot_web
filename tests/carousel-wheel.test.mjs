import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createCarouselWheelController } from "../components/landing/carousel-scroll.ts"

function recording(name) {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/carousel-wheel/${name}.json`, import.meta.url),
      "utf8"
    )
  ).wheelEvents
}

// The upstream double-swipe recording is horizontal. Rotate both axes while
// preserving every recorded magnitude and timestamp; see the fixture README.
function verticalDoubleSwipe(direction = 1) {
  return recording("double-swipe-right").map((event) => ({
    ...event,
    deltaX: event.deltaY,
    deltaY: -event.deltaX * direction,
  }))
}

function harness(
  t,
  { index = 0, scrollHeight = 600, viewportHeight = 600 } = {}
) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  let currentIndex = index
  const positions = new Map()
  const navigations = []
  const scrolls = []
  const maximum = Math.max(0, scrollHeight - viewportHeight)
  const controller = createCarouselWheelController({
    getSection() {
      return {
        index: currentIndex,
        scrollTop: positions.get(currentIndex) ?? 0,
        scrollHeight,
        viewportHeight,
      }
    },
    onScroll(delta) {
      scrolls.push({ index: currentIndex, delta })
      positions.set(
        currentIndex,
        Math.max(
          0,
          Math.min(maximum, (positions.get(currentIndex) ?? 0) + delta)
        )
      )
    },
    onNavigate(direction) {
      navigations.push({ index: currentIndex, direction })
      currentIndex += direction
    },
  })
  t.after(() => controller.destroy())
  let previousTimeStamp = null

  return {
    controller,
    navigations,
    scrolls,
    positions,
    get index() {
      return currentIndex
    },
    set index(next) {
      currentIndex = next
    },
    replay(events) {
      for (const event of events) {
        if (previousTimeStamp !== null) {
          t.mock.timers.tick(event.timeStamp - previousTimeStamp)
        }
        controller.feedWheel(event)
        previousTimeStamp = event.timeStamp
      }
    },
  }
}

for (const [name, direction] of [
  ["swipe-up-trackpad", 1],
  ["swipe-up-fast-trackpad", 1],
  ["swipe-down-trackpad", -1],
  ["swipe-down-fast-trackpad", -1],
]) {
  test(`recorded ${name} advances once through its entire momentum tail`, (t) => {
    const state = harness(t, { index: 2 })
    state.replay(recording(name))
    assert.deepEqual(state.navigations, [{ index: 2, direction }])
    assert.equal(state.scrolls.length, 0)
    assert.equal(state.index, 2 + direction)
  })
}

for (const direction of [1, -1]) {
  test(`recorded successive ${direction > 0 ? "forward" : "reverse"} swipes advance twice without an idle gap`, (t) => {
    const events = verticalDoubleSwipe(direction)
    const largestGap = Math.max(
      ...events
        .slice(1)
        .map((event, index) => event.timeStamp - events[index].timeStamp)
    )
    assert(
      largestGap < 40,
      "the recording never pauses long enough for an idle-only latch"
    )
    const state = harness(t, { index: 2 })
    state.replay(events)
    assert.deepEqual(state.navigations, [
      { index: 2, direction },
      { index: 2 + direction, direction },
    ])
    assert.equal(state.index, 2 + direction * 2)
  })
}

test("a recorded reading swipe reaches the overflow boundary without navigating through its momentum", (t) => {
  const state = harness(t, { scrollHeight: 1400 })
  state.replay(recording("swipe-up-fast-trackpad"))
  assert.equal(state.positions.get(0), 800)
  assert.equal(state.scrolls.length > 1, true)
  assert.deepEqual(state.navigations, [])
  assert.equal(state.index, 0)
})

test("a renewed recorded swipe at the reading boundary advances while the previous momentum is still arriving", (t) => {
  const state = harness(t, { scrollHeight: 1400 })
  state.replay(verticalDoubleSwipe())
  assert.equal(state.positions.get(0), 800)
  assert.deepEqual(state.navigations, [{ index: 0, direction: 1 }])
  assert.equal(state.index, 1)
  assert.equal(
    state.positions.has(1),
    false,
    "outgoing momentum does not scroll the incoming section"
  )
})

test("an external section change does not redirect a reading gesture into the incoming section", (t) => {
  const state = harness(t, { scrollHeight: 2400 })
  const events = recording("swipe-up-trackpad")
  state.replay(events.slice(0, 10))
  const originalPosition = state.positions.get(0)
  assert(originalPosition > 0)
  state.index = 1
  state.replay(events.slice(10))
  assert.equal(state.positions.get(0), originalPosition)
  assert.equal(state.positions.has(1), false)
  assert.deepEqual(state.navigations, [])
})

test("the unrotated recorded horizontal double swipe leaves the vertical carousel alone", (t) => {
  const state = harness(t)
  state.replay(recording("double-swipe-right"))
  assert.deepEqual(state.navigations, [])
  assert.deepEqual(state.scrolls, [])
  assert.equal(state.index, 0)
})

test("a stream beginning with browser-reported momentum waits for renewed user input", (t) => {
  const state = harness(t)
  state.replay([
    { deltaMode: 0, deltaX: 0, deltaY: 60, timeStamp: 0, momentum: true },
    { deltaMode: 0, deltaX: 0, deltaY: 40, timeStamp: 16, momentum: true },
    { deltaMode: 0, deltaX: 0, deltaY: 20, timeStamp: 32, momentum: true },
  ])
  assert.deepEqual(state.navigations, [])
  state.replay([
    { deltaMode: 0, deltaX: 0, deltaY: 30, timeStamp: 48, momentum: false },
    { deltaMode: 0, deltaX: 0, deltaY: 20, timeStamp: 64, momentum: false },
    { deltaMode: 0, deltaX: 0, deltaY: 10, timeStamp: 80, momentum: true },
  ])
  assert.deepEqual(state.navigations, [{ index: 0, direction: 1 }])
})

for (const [name, deltaMode, deltaY] of [
  ["pixel", 0, 60],
  ["line", 1, 3],
]) {
  test(`successive sparse ${name} mouse-wheel ticks each advance a section`, (t) => {
    const state = harness(t)
    state.replay(
      Array.from({ length: 8 }, (_, index) => ({
        deltaMode,
        deltaX: 0,
        deltaY,
        timeStamp: index * 250,
      }))
    )
    assert.deepEqual(
      state.navigations,
      Array.from({ length: 8 }, (_, index) => ({ index, direction: 1 }))
    )
    assert.equal(state.scrolls.length, 0)
  })
}
