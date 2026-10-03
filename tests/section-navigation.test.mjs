import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getSectionIndex,
  getSectionNavigation,
  getSectionSettlement,
} from "../components/landing/section-navigation.ts"

test("a section that fits the viewport advances directly to the next top", () => {
  for (const height of [500, 800]) {
    const sections = [
      { top: 0, height },
      { top: height, height: 1200 },
    ]
    assert.deepEqual(getSectionNavigation(sections, 0, 0, 800, 1), {
      boundary: 0,
      canScroll: false,
      target: height,
    })
  }
})

test("native settlement preserves interior scrolling and advances at the boundary", () => {
  const sections = [
    { top: 0, height: 600 },
    { top: 600, height: 1000 },
    { top: 1600, height: 600 },
  ]
  assert.equal(getSectionSettlement(sections, 1, 800, 600, 1), null)
  assert.equal(getSectionSettlement(sections, 1, 1000, 600, 1), 1600)
  assert.equal(getSectionSettlement(sections, 1, 600, 600, -1), 0)
})

test("a reversed native gesture brings its original section fully back into view", () => {
  const sections = [
    { top: 0, height: 600 },
    { top: 600, height: 1000 },
    { top: 1600, height: 600 },
  ]
  assert.equal(getSectionSettlement(sections, 1, 1550, 600, -1), 1000)
  assert.equal(getSectionSettlement(sections, 1, 50, 600, 1), 600)
})

test("interrupted native momentum settles to the adjacent section", () => {
  const sections = [
    { top: 0, height: 600 },
    { top: 600, height: 1000 },
    { top: 1600, height: 600 },
  ]
  assert.equal(getSectionSettlement(sections, 1, 1200, 600, 1), 1600)
  assert.equal(getSectionSettlement(sections, 1, 400, 600, -1), 0)
})

test("a tall section keeps native scrolling available until its lower boundary", () => {
  const sections = [
    { top: 0, height: 800 },
    { top: 800, height: 1400 },
    { top: 2200, height: 800 },
  ]

  for (const scrollTop of [800, 1100, 1390]) {
    assert.equal(
      getSectionNavigation(sections, 1, scrollTop, 800, 1).canScroll,
      true
    )
  }
  assert.deepEqual(getSectionNavigation(sections, 1, 1400, 800, 1), {
    boundary: 1400,
    canScroll: false,
    target: 2200,
  })
})

test("a tall section scrolls upward normally until its upper boundary", () => {
  const sections = [
    { top: 0, height: 800 },
    { top: 800, height: 1400 },
  ]

  for (const scrollTop of [1400, 1100, 810]) {
    assert.equal(
      getSectionNavigation(sections, 1, scrollTop, 800, -1).canScroll,
      true
    )
  }
  assert.deepEqual(getSectionNavigation(sections, 1, 800, 800, -1), {
    boundary: 800,
    canScroll: false,
    target: 0,
  })
})

test("backward navigation enters a tall previous section at its bottom", () => {
  const sections = [
    { top: 0, height: 800 },
    { top: 800, height: 1400 },
    { top: 2200, height: 800 },
  ]
  const back = getSectionNavigation(sections, 2, 2200, 800, -1)

  assert.equal(back.canScroll, false)
  assert.equal(back.target, 1400)
  assert.equal(getSectionIndex(sections, back.target), 1)
  assert.equal(
    getSectionNavigation(sections, 1, back.target, 800, -1).canScroll,
    true
  )
})

test("backward navigation enters a fitting previous section at its top", () => {
  const sections = [
    { top: 0, height: 500 },
    { top: 500, height: 800 },
  ]
  assert.deepEqual(getSectionNavigation(sections, 1, 500, 800, -1), {
    boundary: 500,
    canScroll: false,
    target: 0,
  })
})

test("fractional positions within two pixels of either boundary can navigate", () => {
  const sections = [
    { top: 0, height: 900 },
    { top: 900, height: 900 },
    { top: 1800, height: 600 },
  ]

  assert.equal(
    getSectionNavigation(sections, 1, 1197.9, 600, 1).canScroll,
    true
  )
  assert.equal(
    getSectionNavigation(sections, 1, 1198.5, 600, 1).canScroll,
    false
  )
  assert.equal(
    getSectionNavigation(sections, 1, 902.1, 600, -1).canScroll,
    true
  )
  assert.equal(
    getSectionNavigation(sections, 1, 901.5, 600, -1).canScroll,
    false
  )
})

test("the same section adapts to a small desktop viewport and a larger viewport", () => {
  const sections = [
    { top: 0, height: 720 },
    { top: 720, height: 720 },
  ]

  const smallViewport = getSectionNavigation(sections, 0, 0, 500, 1)
  assert.equal(smallViewport.canScroll, true)
  assert.equal(smallViewport.boundary, 220)
  assert.equal(getSectionNavigation(sections, 0, 220, 500, 1).canScroll, false)

  const largeViewport = getSectionNavigation(sections, 0, 0, 900, 1)
  assert.equal(largeViewport.canScroll, false)
  assert.equal(largeViewport.boundary, 0)
  assert.equal(largeViewport.target, 720)
})

test("the first and final sections have no destination beyond the page", () => {
  const sections = [
    { top: 0, height: 600 },
    { top: 600, height: 1200 },
  ]

  assert.deepEqual(getSectionNavigation(sections, 0, 0, 600, -1), {
    boundary: 0,
    canScroll: false,
    target: null,
  })
  assert.equal(getSectionNavigation(sections, 1, 900, 600, 1).canScroll, true)
  assert.deepEqual(getSectionNavigation(sections, 1, 1200, 600, 1), {
    boundary: 1200,
    canScroll: false,
    target: null,
  })
})

test("section selection stays with a tall section while its content scrolls", () => {
  const sections = [
    { top: 0, height: 600 },
    { top: 600, height: 1500 },
    { top: 2100, height: 600 },
  ]

  assert.equal(getSectionIndex(sections, -10), 0)
  assert.equal(getSectionIndex(sections, 0), 0)
  assert.equal(getSectionIndex(sections, 600), 1)
  assert.equal(getSectionIndex(sections, 1500), 1)
  assert.equal(getSectionIndex(sections, 2097.9), 1)
  assert.equal(getSectionIndex(sections, 2098.5), 2)
  assert.equal(getSectionIndex(sections, 2100), 2)
  assert.equal(getSectionIndex(sections, 2800), 2)
})
