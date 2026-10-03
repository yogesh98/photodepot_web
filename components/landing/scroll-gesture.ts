const GESTURE_IDLE_MS = 250
const SCROLL_THRESHOLD = 4
const RENEWAL_DELAY_MS = 150
const RENEWAL_SAMPLE_MS = 100
const RENEWAL_DELTA = 8
const RENEWAL_TAIL_MARGIN = 4
const RENEWAL_SUSTAIN_RATIO = 0.75

export function createScrollGesture() {
  let lastEventAt = -Infinity
  let accumulatedDelta = 0
  let consumed = false
  let consumedAt = -Infinity
  let consumedDirection = 0
  let peakDelta = 0
  let tailDelta = Infinity
  let candidate: { delta: number; at: number; tail: number } | null = null

  function beginGesture(delta: number) {
    accumulatedDelta = delta
    consumed = false
    peakDelta = Math.abs(delta)
    tailDelta = peakDelta
    candidate = null
  }

  return {
    update(delta: number, now: number) {
      const magnitude = Math.abs(delta)
      const direction = Math.sign(delta)
      // A pause starts a new gesture, regardless of where the cursor is.
      if (now - lastEventAt >= GESTURE_IDLE_MS) {
        beginGesture(delta)
      } else if (!consumed) {
        if (Math.sign(accumulatedDelta) !== direction) {
          accumulatedDelta = 0
        }
        accumulatedDelta += delta
        peakDelta = Math.max(peakDelta, magnitude)
      } else {
        const reversed = direction !== consumedDirection
        const canRenew =
          now - consumedAt >= RENEWAL_DELAY_MS && magnitude >= RENEWAL_DELTA
        const confirmed =
          canRenew &&
          candidate !== null &&
          now - candidate.at <= RENEWAL_SAMPLE_MS &&
          Math.sign(candidate.delta) === direction &&
          (reversed ||
            magnitude >=
              Math.max(
                Math.abs(candidate.delta) * RENEWAL_SUSTAIN_RATIO,
                candidate.tail * 2,
                candidate.tail + RENEWAL_TAIL_MARGIN
              ))

        if (confirmed && candidate) {
          const firstDelta = candidate.delta
          beginGesture(delta)
          accumulatedDelta += firstDelta
          peakDelta = Math.max(peakDelta, Math.abs(firstDelta))
        } else {
          // A sustained push above a decayed tail can start a new gesture.
          // Requiring a second strong sample rejects isolated momentum spikes,
          // while allowing the first sample of a fresh gesture to be strongest.
          if (candidate) {
            // A rejected spike establishes a new tail. Do not reuse its
            // declining samples as fresh candidates against the older low tail.
            candidate = null
            if (!reversed) tailDelta = magnitude
          } else {
            candidate =
              canRenew &&
              (reversed ||
                (tailDelta <= peakDelta / 3 &&
                  magnitude >=
                    Math.max(tailDelta * 2, tailDelta + RENEWAL_TAIL_MARGIN)))
                ? { delta, at: now, tail: tailDelta }
                : null
          }

          if (!reversed) {
            if (magnitude > peakDelta) {
              peakDelta = magnitude
              tailDelta = magnitude
            } else {
              tailDelta = Math.min(tailDelta, magnitude)
            }
          }
        }
      }
      lastEventAt = now

      return {
        consumed,
        direction:
          Math.abs(accumulatedDelta) >= SCROLL_THRESHOLD
            ? Math.sign(accumulatedDelta)
            : 0,
      }
    },
    consume() {
      if (consumed) return
      consumed = true
      consumedAt = lastEventAt
      consumedDirection = Math.sign(accumulatedDelta)
      candidate = null
    },
  }
}
