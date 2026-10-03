import assert from "node:assert/strict"
import { test } from "node:test"
import { createScrollGesture } from "../components/landing/scroll-gesture.ts"

test("a sustained scroll and its momentum advance only one section", () => {
  const gesture = createScrollGesture()
  let transitions = 0
  // This stream lasts much longer than a section transition, then tapers off.
  for (let now = 0; now <= 2400; now += 60) {
    const delta = Math.max(1, 100 - now / 25)
    const input = gesture.update(delta, now)
    if (!input.consumed && input.direction !== 0) {
      transitions += 1
      gesture.consume()
    }
  }
  assert.equal(transitions, 1)
})

test("a separate gesture works after a pause without any cursor input", () => {
  const gesture = createScrollGesture()
  assert.equal(gesture.update(20, 0).direction, 1)
  gesture.consume()
  assert.equal(gesture.update(8, 5000).consumed, false)
  gesture.consume()
  const reverse = gesture.update(-8, 5500)
  assert.equal(reverse.consumed, false)
  assert.equal(reverse.direction, -1)
})

test("small trailing events keep the previous gesture consumed", () => {
  const gesture = createScrollGesture()
  gesture.update(30, 0)
  gesture.consume()
  for (const now of [180, 360, 540, 720, 900]) {
    assert.equal(gesture.update(1, now).consumed, true)
  }
  assert.equal(gesture.update(4, 1200).consumed, false)
})

test("a light scroll still triggers at the reduced threshold", () => {
  const gesture = createScrollGesture()
  assert.equal(gesture.update(2, 0).direction, 0)
  assert.equal(gesture.update(2, 20).direction, 1)
})

test("tiny inputs from an earlier gesture do not accumulate after a pause", () => {
  const gesture = createScrollGesture()
  assert.equal(gesture.update(3, 0).direction, 0)
  assert.equal(gesture.update(1, 1000).direction, 0)
  assert.equal(gesture.update(3, 1020).direction, 1)
})

test("a fresh impulse during a momentum tail advances again without cursor input", () => {
  const gesture = createScrollGesture()
  gesture.update(60, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, 40],
    [120, 20],
    [180, 6],
    [240, 2],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
  assert.equal(gesture.update(12, 280).consumed, true)
  const renewed = gesture.update(24, 296)
  assert.equal(renewed.consumed, false)
  assert.equal(renewed.direction, 1)
  gesture.consume()
  for (const [now, delta] of [
    [320, 20],
    [380, 8],
    [440, 2],
    [600, 1],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
})

for (const [name, deltas] of [
  ["steady", [12, 12]],
  ["initially strongest", [24, 20]],
]) {
  test(`${name} fresh input advances after a decaying momentum tail`, () => {
    const gesture = createScrollGesture()
    gesture.update(60, 0)
    gesture.consume()
    for (const [now, delta] of [
      [60, 40],
      [120, 20],
      [180, 6],
      [240, 2],
    ]) {
      assert.equal(gesture.update(delta, now).consumed, true)
    }
    assert.equal(gesture.update(deltas[0], 280).consumed, true)
    const renewed = gesture.update(deltas[1], 296)
    assert.equal(renewed.consumed, false)
    assert.equal(renewed.direction, 1)
    gesture.consume()
    assert.equal(gesture.update(8, 320).consumed, true)
    assert.equal(gesture.update(2, 400).consumed, true)
  })
}

test("tail fluctuations must sustain a clear increase above the preceding tail", () => {
  const gesture = createScrollGesture()
  gesture.update(60, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, 40],
    [120, 20],
    [180, 6],
    [240, 12],
    [256, 9],
    [300, 6],
    [340, 12],
    [356, 11],
    [400, 6],
    [440, 8],
    [456, 8],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
})

test("an isolated momentum spike and small tail fluctuations do not advance again", () => {
  const gesture = createScrollGesture()
  gesture.update(60, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, 40],
    [120, 20],
    [180, 6],
    [240, 2],
    [280, 80],
    [296, 14],
    [340, 8],
    [400, 3],
    [460, 4],
    [520, 2],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
})

test("the declining side of a sub-peak momentum spike does not become a new gesture", () => {
  const gesture = createScrollGesture()
  gesture.update(60, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, 40],
    [120, 20],
    [180, 6],
    [240, 2],
    [280, 40],
    [296, 14],
    [312, 12],
    [340, 8],
    [400, 2],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
  // A genuine new push still works after that rejected spike decays.
  assert.equal(gesture.update(12, 440).consumed, true)
  assert.equal(gesture.update(12, 456).consumed, false)
})

test("rising deltas in the original strong gesture stay consumed until it decays", () => {
  const gesture = createScrollGesture()
  gesture.update(40, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, 60],
    [120, 50],
    [180, 40],
    [240, 48],
    [256, 60],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
})

test("a deliberate two-sample reversal works before the previous gesture goes idle", () => {
  const gesture = createScrollGesture()
  gesture.update(40, 0)
  gesture.consume()
  gesture.update(20, 100)
  gesture.update(8, 200)
  assert.equal(gesture.update(-12, 240).consumed, true)
  const reversed = gesture.update(-12, 256)
  assert.equal(reversed.consumed, false)
  assert.equal(reversed.direction, -1)
})

test("minor direction jitter and one opposite spike remain part of the same gesture", () => {
  const gesture = createScrollGesture()
  gesture.update(40, 0)
  gesture.consume()
  for (const [now, delta] of [
    [100, 20],
    [200, 8],
    [240, -1],
    [256, -2],
    [280, -20],
    [296, 4],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
})

test("repeated consume calls during a transition do not prolong the gesture lock", () => {
  const gesture = createScrollGesture()
  gesture.update(-60, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, -40],
    [120, -20],
    [180, -6],
    [240, -2],
  ]) {
    gesture.update(delta, now)
    gesture.consume()
  }
  assert.equal(gesture.update(-12, 280).consumed, true)
  const renewed = gesture.update(-24, 296)
  assert.equal(renewed.consumed, false)
  assert.equal(renewed.direction, -1)
})

test("explicitly consuming a renewed impulse suppresses its remaining momentum", () => {
  const gesture = createScrollGesture()
  gesture.update(60, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, 40],
    [120, 20],
    [180, 6],
    [240, 2],
    [280, 12],
    [296, 24],
  ]) {
    gesture.update(delta, now)
    gesture.consume()
  }
  for (const [now, delta] of [
    [320, 20],
    [400, 8],
    [500, 2],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
  assert.equal(gesture.update(12, 560).consumed, true)
  assert.equal(gesture.update(24, 576).consumed, false)
})

test("a fresh impulse remains available until the animation ends and is consumed once", () => {
  const gesture = createScrollGesture()
  gesture.update(60, 0)
  gesture.consume()
  for (const [now, delta] of [
    [60, 40],
    [120, 20],
    [180, 6],
    [240, 2],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
  assert.equal(gesture.update(12, 280).consumed, true)
  assert.equal(gesture.update(24, 296).consumed, false)
  // The active animation blocks navigation but does not consume new intent.
  assert.equal(gesture.update(20, 320).consumed, false)
  const settled = gesture.update(16, 360)
  assert.equal(settled.consumed, false)
  assert.equal(settled.direction, 1)
  gesture.consume()
  for (const [now, delta] of [
    [400, 12],
    [460, 6],
    [520, 2],
    [600, 1],
  ]) {
    assert.equal(gesture.update(delta, now).consumed, true)
  }
})
