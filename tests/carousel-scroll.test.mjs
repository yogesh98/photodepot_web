import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getCarouselEntryScrollTop,
  getCarouselScrollAction,
  getCarouselSwipeAction,
} from "../components/landing/carousel-scroll.ts"

const overflowingSection = { scrollHeight: 1200, viewportHeight: 600 }

test("sections that fit advance in either direction", () => {
  for (const scrollHeight of [400, 600]) {
    for (const [delta, expected] of [
      [20, "next"],
      [-20, "previous"],
      [0, "native"],
    ]) {
      assert.equal(
        getCarouselScrollAction({
          scrollHeight,
          viewportHeight: 600,
          scrollTop: 0,
          delta,
        }),
        expected
      )
    }
  }
})

test("overflow scrolls natively until the requested direction reaches its edge", () => {
  for (const [scrollTop, delta, expected] of [
    [0, 30, "native"],
    [0, -30, "previous"],
    [300, 30, "native"],
    [300, -30, "native"],
    [600, 30, "next"],
    [600, -30, "native"],
    [600, 0, "native"],
  ]) {
    assert.equal(
      getCarouselScrollAction({ ...overflowingSection, scrollTop, delta }),
      expected
    )
  }
})

test("fractional scroll positions use a two-pixel edge tolerance", () => {
  for (const [scrollTop, delta, expected] of [
    [2.01, -1, "native"],
    [2, -1, "previous"],
    [1.75, -1, "previous"],
    [597.99, 1, "native"],
    [598, 1, "next"],
    [598.25, 1, "next"],
  ]) {
    assert.equal(
      getCarouselScrollAction({ ...overflowingSection, scrollTop, delta }),
      expected
    )
  }
})

test("a large wheel delta remains native when it starts away from the edge", () => {
  for (const [scrollTop, delta] of [
    [590, 2000],
    [10, -2000],
  ]) {
    assert.equal(
      getCarouselScrollAction({ ...overflowingSection, scrollTop, delta }),
      "native"
    )
  }
})

test("browser overscroll positions still identify the appropriate boundary", () => {
  assert.equal(
    getCarouselScrollAction({
      ...overflowingSection,
      scrollTop: -12,
      delta: -10,
    }),
    "previous"
  )
  assert.equal(
    getCarouselScrollAction({
      ...overflowingSection,
      scrollTop: 612,
      delta: 10,
    }),
    "next"
  )
})

test("only vertical swipes of at least 24 pixels navigate", () => {
  for (const [endX, endY, expected] of [
    [100, 77, "native"],
    [100, 76, "next"],
    [100, 124, "previous"],
    [20, 40, "native"],
    [40, 40, "native"],
    [100, 100, "native"],
  ]) {
    assert.equal(
      getCarouselSwipeAction({
        scrollTop: 0,
        scrollHeight: 600,
        viewportHeight: 600,
        startX: 100,
        startY: 100,
        endX,
        endY,
      }),
      expected
    )
  }
})

test("a large swipe stays native until its anchor is at the bottom boundary", () => {
  const swipe = {
    ...overflowingSection,
    startX: 100,
    startY: 500,
    endX: 110,
    endY: 100,
  }
  assert.equal(getCarouselSwipeAction({ ...swipe, scrollTop: 500 }), "native")
  assert.equal(getCarouselSwipeAction({ ...swipe, scrollTop: 600 }), "next")
})

test("a reverse swipe navigates only with an anchor at the top boundary", () => {
  const swipe = {
    ...overflowingSection,
    startX: 100,
    startY: 100,
    endX: 100,
    endY: 500,
  }
  assert.equal(getCarouselSwipeAction({ ...swipe, scrollTop: 100 }), "native")
  assert.equal(getCarouselSwipeAction({ ...swipe, scrollTop: 0 }), "previous")
})

test("reverse entry opens overflowing sections at their bottom", () => {
  assert.equal(
    getCarouselEntryScrollTop({ ...overflowingSection, direction: -1 }),
    600
  )
  assert.equal(
    getCarouselEntryScrollTop({ ...overflowingSection, direction: 1 }),
    0
  )
  assert.equal(
    getCarouselEntryScrollTop({ ...overflowingSection, direction: 0 }),
    0
  )
  for (const scrollHeight of [400, 600]) {
    assert.equal(
      getCarouselEntryScrollTop({
        scrollHeight,
        viewportHeight: 600,
        direction: -1,
      }),
      0
    )
  }
})
