"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { createScrollGesture } from "./scroll-gesture"
import {
  getSectionEntryPosition,
  getSectionWheelAction,
} from "./section-scroll"
import styles from "./shell.module.css"

export function LandingSections({ children }: { children: ReactNode }) {
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!main.current) return
    const scroller = main.current
    const page = scroller.parentElement
    const sections = Array.from(scroller.querySelectorAll("section"))
    let headerFrame = 0
    let previousScrollTop = scroller.scrollTop
    let scrollingDown = true

    function updateHeaderBackground() {
      headerFrame = 0
      if (!page) return

      if (scroller.scrollTop !== previousScrollTop) {
        scrollingDown = scroller.scrollTop > previousScrollTop
        previousScrollTop = scroller.scrollTop
      }

      const viewport = scroller.getBoundingClientRect()
      const visibleSections = sections.flatMap((section) => {
        const bounds = section.getBoundingClientRect()
        const visibleHeight =
          Math.min(bounds.bottom, viewport.bottom) -
          Math.max(bounds.top, viewport.top)
        return visibleHeight > 0
          ? [
              {
                section,
                color: getComputedStyle(section).backgroundColor,
                visibleHeight,
              },
            ]
          : []
      })
      const [upper, lower] = visibleSections
      if (!upper) return

      let background = upper.color
      let headerSection = upper.section
      if (lower) {
        const progress =
          lower.visibleHeight / (upper.visibleHeight + lower.visibleHeight)
        // Ease in on descent, when the incoming surface reaches the header last.
        const lowerWeight = scrollingDown ? progress ** 3 : progress
        if (lowerWeight >= 0.5) headerSection = lower.section
        background = `color-mix(in srgb, ${upper.color} ${
          (1 - lowerWeight) * 100
        }%, ${lower.color})`
      }
      page.style.setProperty("--header-background", background)
      page.dataset.headerSection = headerSection.id
    }

    function scheduleHeaderUpdate() {
      if (!headerFrame) {
        headerFrame = requestAnimationFrame(updateHeaderBackground)
      }
    }

    updateHeaderBackground()
    scroller.addEventListener("scroll", scheduleHeaderUpdate, { passive: true })
    window.addEventListener("resize", scheduleHeaderUpdate)

    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    )
    const gesture = createScrollGesture()
    let transitionTarget: number | null = null
    let transitionFrame = 0
    let transitionTimer: ReturnType<typeof setTimeout> | undefined

    // Native snap can latch wheel scrolling until the pointer moves. Wheel
    // pagination already chooses its own destination, so use only that path.
    scroller.setAttribute("data-wheel-navigation", "")

    function handlePointerDown(event: PointerEvent) {
      if (event.pointerType === "touch") {
        scroller.removeAttribute("data-wheel-navigation")
      }
    }

    function finishTransition() {
      transitionTarget = null
      cancelAnimationFrame(transitionFrame)
      clearTimeout(transitionTimer)
    }

    function handleScrollEnd() {
      if (
        transitionTarget !== null &&
        Math.abs(scroller.scrollTop - transitionTarget) < 2
      ) {
        finishTransition()
      }
    }

    function handleWheel(event: WheelEvent) {
      if (
        event.ctrlKey ||
        event.deltaY === 0 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ) {
        return
      }

      // Keep native snapping disabled between gestures, including after the
      // animation finishes. A touchscreen swipe opts back into native snap.
      scroller.setAttribute("data-wheel-navigation", "")

      const deltaUnit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? scroller.clientHeight
            : 1
      const delta = event.deltaY * deltaUnit
      const input = gesture.update(delta, performance.now())

      if (transitionTarget !== null) {
        // Keep a fresh swipe available for wheel input after the animation.
        // The previous swipe's momentum stays consumed; nothing is queued.
        event.preventDefault()
        return
      }
      if (input.consumed) {
        event.preventDefault()
        return
      }

      const viewportTop = scroller.getBoundingClientRect().top
      const positions = sections.map(
        (section) =>
          section.getBoundingClientRect().top - viewportTop + scroller.scrollTop
      )
      const currentIndex = positions.findLastIndex(
        (position) => position <= scroller.scrollTop + 2
      )
      const currentSection = sections[currentIndex]
      if (!currentSection) return

      const direction = Math.sign(event.deltaY)
      const sectionStart = positions[currentIndex]
      const sectionEnd =
        sectionStart + currentSection.getBoundingClientRect().height

      const action = getSectionWheelAction({
        scrollTop: scroller.scrollTop,
        delta,
        viewportHeight: scroller.clientHeight,
        sectionStart,
        sectionEnd,
      })
      if (action.type === "native") return

      event.preventDefault()
      if (action.type === "edge") {
        // Stop at the end of the readable content. The rest of this gesture's
        // momentum must not immediately carry the visitor to another section.
        scroller.scrollTo({ top: action.top, behavior: "instant" })
        gesture.consume()
        return
      }

      if (input.direction === 0) return

      const nextIndex = Math.max(
        0,
        Math.min(sections.length - 1, currentIndex + direction)
      )
      gesture.consume()
      if (nextIndex === currentIndex) return

      const target = Math.min(
        getSectionEntryPosition({
          sectionStart: positions[nextIndex],
          sectionEnd:
            positions[nextIndex] +
            sections[nextIndex].getBoundingClientRect().height,
          viewportHeight: scroller.clientHeight,
          direction,
        }),
        scroller.scrollHeight - scroller.clientHeight
      )
      transitionTarget = target
      // Release even if scrolling is interrupted or animation frames are paused.
      transitionTimer = setTimeout(finishTransition, 1500)
      scroller.scrollTo({
        top: target,
        behavior: motionPreference.matches ? "instant" : "smooth",
      })

      function checkTransition() {
        if (Math.abs(scroller.scrollTop - target) < 2) {
          finishTransition()
          return
        }
        transitionFrame = requestAnimationFrame(checkTransition)
      }
      transitionFrame = requestAnimationFrame(checkTransition)
    }

    scroller.addEventListener("wheel", handleWheel, { passive: false })
    scroller.addEventListener("pointerdown", handlePointerDown)
    scroller.addEventListener("scrollend", handleScrollEnd)
    return () => {
      scroller.removeEventListener("wheel", handleWheel)
      scroller.removeEventListener("pointerdown", handlePointerDown)
      scroller.removeAttribute("data-wheel-navigation")
      scroller.removeEventListener("scrollend", handleScrollEnd)
      scroller.removeEventListener("scroll", scheduleHeaderUpdate)
      window.removeEventListener("resize", scheduleHeaderUpdate)
      cancelAnimationFrame(headerFrame)
      page?.style.removeProperty("--header-background")
      if (page) delete page.dataset.headerSection
      clearTimeout(transitionTimer)
      cancelAnimationFrame(transitionFrame)
    }
  }, [])

  return (
    <main ref={main} id="main" className={styles.sections} tabIndex={0}>
      {children}
    </main>
  )
}
