import assert from "node:assert/strict"
import { test } from "node:test"
import {
  getSectionEntryPosition,
  getSectionWheelAction,
} from "../components/landing/section-scroll.ts"
import { createScrollGesture } from "../components/landing/scroll-gesture.ts"

const tallSection = {
  sectionStart: 600,
  sectionEnd: 1800,
  viewportHeight: 600,
}

test("tall sections scroll freely until a wheel event reaches either reading edge", () => {
  for (const [scrollTop, delta] of [
    [800, 30],
    [800, -30],
  ]) {
    assert.deepEqual(
      getSectionWheelAction({ ...tallSection, scrollTop, delta }),
      { type: "native" }
    )
  }
  for (const [scrollTop, delta, top] of [
    [1180, 100, 1200],
    [1180, 20, 1200],
    [620, -100, 600],
    [620, -20, 600],
  ]) {
    assert.deepEqual(
      getSectionWheelAction({ ...tallSection, scrollTop, delta }),
      { type: "edge", top }
    )
  }
})

test("reaching a reading edge consumes momentum until a fresh gesture", () => {
  for (const direction of [1, -1]) {
    const gesture = createScrollGesture()
    const scrollTop = direction > 0 ? 1180 : 620
    const delta = direction * 100
    gesture.update(delta, 0)
    const action = getSectionWheelAction({ ...tallSection, scrollTop, delta })
    assert.equal(action.type, "edge")
    gesture.consume()
    for (const [now, magnitude] of [
      [60, 60],
      [120, 30],
      [180, 10],
      [240, 2],
    ]) {
      assert.equal(gesture.update(direction * magnitude, now).consumed, true)
    }
    const fresh = gesture.update(direction * 20, 600)
    assert.equal(fresh.consumed, false)
    assert.deepEqual(
      getSectionWheelAction({
        ...tallSection,
        scrollTop: action.top,
        delta: direction * 20,
      }),
      { type: "navigate" }
    )
  }
})

test("sections that fit the viewport keep immediate wheel pagination", () => {
  for (const delta of [4, -4]) {
    assert.deepEqual(
      getSectionWheelAction({
        sectionStart: 600,
        sectionEnd: 1200,
        viewportHeight: 600,
        scrollTop: 600,
        delta,
      }),
      { type: "navigate" }
    )
  }
})

test("upward navigation enters a tall section at its bottom without skipping its content", () => {
  assert.equal(getSectionEntryPosition({ ...tallSection, direction: -1 }), 1200)
  assert.equal(getSectionEntryPosition({ ...tallSection, direction: 1 }), 600)
  assert.equal(
    getSectionEntryPosition({
      ...tallSection,
      sectionEnd: 1200,
      direction: -1,
    }),
    600
  )
})
