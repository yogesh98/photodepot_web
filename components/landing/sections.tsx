"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { createScrollGesture } from "./scroll-gesture"
import {
  getSectionIndex,
  getSectionNavigation,
  getSectionSettlement,
} from "./section-navigation"
import styles from "./shell.module.css"

const SWIPE_THRESHOLD = 32
const SCROLL_SETTLE_MS = 150

type TouchNavigation = {
  identifier: number
  startX: number
  startY: number
  lastY: number
  lastScrollTop: number
  index: number
  direction: number
  mode: "pending" | "native" | "section" | "ignored"
  consumed: boolean
  ended: boolean
}

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
    let touch: TouchNavigation | null = null
    let settleTimer: ReturnType<typeof setTimeout> | undefined

    // One controller owns section destinations for every viewport and input.
    // Native scrolling remains available inside sections that overflow it.
    scroller.setAttribute("data-section-navigation", "")

    function readSections() {
      const viewportTop = scroller.getBoundingClientRect().top
      return sections.map((section) => {
        const bounds = section.getBoundingClientRect()
        return {
          top: bounds.top - viewportTop + scroller.scrollTop,
          height: bounds.height,
        }
      })
    }

    function clearTouch() {
      touch = null
      clearTimeout(settleTimer)
    }

    function finishTransition() {
      transitionTarget = null
      cancelAnimationFrame(transitionFrame)
      clearTimeout(transitionTimer)
    }

    function navigateTo(target: number) {
      target = Math.max(
        0,
        Math.min(target, scroller.scrollHeight - scroller.clientHeight)
      )
      if (Math.abs(scroller.scrollTop - target) < 2) return
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

    function settleTouch() {
      if (!touch?.ended || touch.mode !== "native") return
      const target = getSectionSettlement(
        readSections(),
        touch.index,
        scroller.scrollTop,
        scroller.clientHeight,
        touch.direction
      )
      clearTouch()
      if (target !== null) navigateTo(target)
    }

    function scheduleTouchSettlement() {
      clearTimeout(settleTimer)
      if (touch?.ended) {
        // Also support browsers without scrollend. Each momentum update restarts
        // this timer, and an active finger never triggers section settlement.
        settleTimer = setTimeout(settleTouch, SCROLL_SETTLE_MS)
      }
    }

    function handleScrollEnd() {
      if (
        transitionTarget !== null &&
        Math.abs(scroller.scrollTop - transitionTarget) < 2
      ) {
        finishTransition()
      }
      // Programmatic clamping can emit scrollend while a native fling still has
      // pending updates. Wait for the same quiet period as the fallback path.
      scheduleTouchSettlement()
    }

    function handleTouchStart(event: TouchEvent) {
      const interrupted = touch?.mode === "native" && touch.ended ? touch : null
      clearTouch()
      if (
        event.touches.length !== 1 ||
        (window.visualViewport && window.visualViewport.scale !== 1)
      ) {
        return
      }
      const point = event.touches[0]
      touch = {
        identifier: point.identifier,
        startX: point.clientX,
        startY: point.clientY,
        lastY: point.clientY,
        lastScrollTop: scroller.scrollTop,
        index:
          interrupted?.index ??
          getSectionIndex(readSections(), scroller.scrollTop),
        direction: interrupted?.direction ?? 0,
        mode: "pending",
        consumed: false,
        ended: false,
      }
    }

    function handleTouchMove(event: TouchEvent) {
      if (!touch) return
      if (event.touches.length !== 1) {
        clearTouch()
        return
      }
      const point = Array.from(event.touches).find(
        (point) => point.identifier === touch?.identifier
      )
      if (!point) return

      const deltaX = touch.startX - point.clientX
      const deltaY = touch.startY - point.clientY
      const stepY = touch.lastY - point.clientY
      touch.lastY = point.clientY
      if (touch.mode === "ignored") {
        // A swipe can curve from horizontal to vertical after native panning
        // begins. Let it stay native, with the same boundary settlement.
        if (
          Math.abs(deltaY) > Math.abs(deltaX) &&
          Math.abs(deltaY) >= SWIPE_THRESHOLD
        ) {
          touch.mode = "native"
          touch.direction = Math.sign(deltaY)
        }
        return
      }
      if (touch.mode === "pending") {
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
          touch.mode = "ignored"
          return
        }
        if (deltaY === 0) return
        touch.index = getSectionIndex(readSections(), scroller.scrollTop)
        touch.direction = Math.sign(deltaY)
        const { canScroll } = getSectionNavigation(
          readSections(),
          touch.index,
          scroller.scrollTop,
          scroller.clientHeight,
          touch.direction
        )
        // Cancel from the first vertical move when paging. Once native panning
        // starts, leave it native and settle only after release and momentum.
        touch.mode =
          !canScroll || transitionTarget !== null ? "section" : "native"
      }

      if (touch.mode === "native") {
        return
      }

      if (!event.cancelable) return
      event.preventDefault()
      if (touch.consumed) return
      if (transitionTarget !== null) {
        touch.consumed = true
        return
      }
      if (Math.abs(deltaY) < SWIPE_THRESHOLD) return

      const direction = Math.sign(deltaY)
      const { canScroll, target } = getSectionNavigation(
        readSections(),
        touch.index,
        scroller.scrollTop,
        scroller.clientHeight,
        direction
      )
      if (canScroll) {
        // A boundary-start drag can reverse back into an overflowing section
        // after its first move was cancelled. Keep that content accessible.
        const section = readSections()[touch.index]
        scroller.scrollTo({
          top: Math.max(
            section.top,
            Math.min(
              section.top + Math.max(0, section.height - scroller.clientHeight),
              scroller.scrollTop + stepY
            )
          ),
          behavior: "instant",
        })
        return
      }
      touch.consumed = true
      if (target !== null) navigateTo(target)
    }

    function handleTouchEnd() {
      if (!touch) return
      // A tap can interrupt momentum between sections. Retain its destination
      // so the tap stops the fling without leaving the viewport stranded.
      if (touch.mode === "pending" && touch.direction !== 0) {
        touch.mode = "native"
      }
      if (touch.mode !== "native") {
        clearTouch()
        return
      }
      touch.ended = true
      scheduleTouchSettlement()
    }

    function handleTouchScroll() {
      if (touch?.mode !== "native" || transitionTarget !== null) return
      const bounds = readSections()
      const delta = scroller.scrollTop - touch.lastScrollTop
      touch.lastScrollTop = scroller.scrollTop
      // Native momentum determines travel direction. Ignore tiny opposite
      // jitter instead of treating the final finger sample as a reversal.
      if (delta * touch.direction > 0 || Math.abs(delta) >= 4) {
        touch.direction = Math.sign(delta)
      }
      // Cap native travel at the adjacent destination so a fling cannot skip
      // over several sections before its momentum finishes.
      const { target } = getSectionNavigation(
        bounds,
        touch.index,
        scroller.scrollTop,
        scroller.clientHeight,
        touch.direction
      )
      if (
        target !== null &&
        (touch.direction > 0
          ? scroller.scrollTop > target
          : scroller.scrollTop < target)
      ) {
        touch.lastScrollTop = target
        scroller.scrollTo({ top: target, behavior: "instant" })
      }
      scheduleTouchSettlement()
    }

    function handleWheel(event: WheelEvent) {
      if (
        event.ctrlKey ||
        event.deltaY === 0 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ) {
        return
      }

      clearTouch()

      const deltaUnit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? scroller.clientHeight
            : 1
      const input = gesture.update(event.deltaY * deltaUnit, performance.now())

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

      const bounds = readSections()
      const currentIndex = getSectionIndex(bounds, scroller.scrollTop)
      const direction = Math.sign(event.deltaY)
      const { boundary, canScroll, target } = getSectionNavigation(
        bounds,
        currentIndex,
        scroller.scrollTop,
        scroller.clientHeight,
        direction
      )

      // Let visitors read a taller section before advancing past its edge.
      if (canScroll) {
        if (
          Math.abs(event.deltaY * deltaUnit) >=
          Math.abs(boundary - scroller.scrollTop)
        ) {
          event.preventDefault()
          scroller.scrollTo({ top: boundary, behavior: "instant" })
        }
        return
      }

      event.preventDefault()
      if (input.direction === 0) return

      gesture.consume()
      if (target !== null) navigateTo(target)
    }

    function handleKeyDown(event: KeyboardEvent) {
      clearTouch()
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.target instanceof Element &&
          (event.target.closest(
            "input, textarea, select, [contenteditable], [role='slider']"
          ) ||
            (event.key === " " &&
              event.target.closest("button, [role='button']"))))
      ) {
        return
      }
      const direction =
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        (event.key === " " && !event.shiftKey)
          ? 1
          : event.key === "ArrowUp" ||
              event.key === "PageUp" ||
              (event.key === " " && event.shiftKey)
            ? -1
            : 0
      if (direction === 0) {
        if (event.key === "Home" || event.key === "End") finishTransition()
        return
      }
      if (transitionTarget !== null) {
        event.preventDefault()
        return
      }
      const bounds = readSections()
      const { boundary, canScroll, target } = getSectionNavigation(
        bounds,
        getSectionIndex(bounds, scroller.scrollTop),
        scroller.scrollTop,
        scroller.clientHeight,
        direction
      )
      if (canScroll) {
        const step = event.key.startsWith("Arrow") ? 40 : scroller.clientHeight
        if (step >= Math.abs(boundary - scroller.scrollTop)) {
          event.preventDefault()
          scroller.scrollTo({
            top: boundary,
            behavior: motionPreference.matches ? "instant" : "smooth",
          })
        }
        return
      }
      event.preventDefault()
      if (target !== null) navigateTo(target)
    }

    function handleNavigationClick(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest("a")) {
        clearTouch()
        finishTransition()
      }
    }

    scroller.addEventListener("wheel", handleWheel, { passive: false })
    scroller.addEventListener("touchstart", handleTouchStart, { passive: true })
    scroller.addEventListener("touchmove", handleTouchMove, { passive: false })
    scroller.addEventListener("touchend", handleTouchEnd)
    scroller.addEventListener("touchcancel", clearTouch)
    scroller.addEventListener("scroll", handleTouchScroll, { passive: true })
    scroller.addEventListener("keydown", handleKeyDown)
    scroller.addEventListener("click", handleNavigationClick)
    scroller.addEventListener("scrollend", handleScrollEnd)
    window.addEventListener("hashchange", clearTouch)
    return () => {
      scroller.removeEventListener("wheel", handleWheel)
      scroller.removeEventListener("touchstart", handleTouchStart)
      scroller.removeEventListener("touchmove", handleTouchMove)
      scroller.removeEventListener("touchend", handleTouchEnd)
      scroller.removeEventListener("touchcancel", clearTouch)
      scroller.removeEventListener("scroll", handleTouchScroll)
      scroller.removeEventListener("keydown", handleKeyDown)
      scroller.removeEventListener("click", handleNavigationClick)
      scroller.removeAttribute("data-section-navigation")
      scroller.removeEventListener("scrollend", handleScrollEnd)
      scroller.removeEventListener("scroll", scheduleHeaderUpdate)
      window.removeEventListener("resize", scheduleHeaderUpdate)
      window.removeEventListener("hashchange", clearTouch)
      cancelAnimationFrame(headerFrame)
      page?.style.removeProperty("--header-background")
      if (page) delete page.dataset.headerSection
      clearTimeout(transitionTimer)
      clearTouch()
      cancelAnimationFrame(transitionFrame)
    }
  }, [])

  return (
    <main ref={main} id="main" className={styles.sections} tabIndex={0}>
      {children}
    </main>
  )
}
