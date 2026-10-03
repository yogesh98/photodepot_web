"use client"

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "@/components/ui/carousel"
import { cn } from "@/lib/utils"
import {
  createCarouselWheelController,
  getCarouselEntryScrollTop,
  getCarouselScrollAction,
  getCarouselSwipeAction,
} from "./carousel-scroll"
import styles from "./shell.module.css"

const sections = [
  { id: "vision", label: "Vision" },
  { id: "workflow", label: "Workflow" },
  { id: "philosophy", label: "Local AI" },
  { id: "collaboration", label: "Teams" },
  { id: "waitlist", label: "Waitlist" },
]

const carouselOptions = {
  align: "start",
  containScroll: false,
  duration: 20,
  loop: false,
  // Native scrolling owns touch gestures within a section. Completed swipes
  // that began at a reading boundary hand off to the carousel.
  watchDrag: false,
  watchFocus: false,
} as const

export function LandingSections({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const main = useRef<HTMLElement>(null)
  const indicators = useRef<HTMLElement>(null)
  const scrollAreas = useRef<(HTMLDivElement | null)[]>([])
  const pendingFocus = useRef<number | null>(null)
  const [api, setApi] = useState<CarouselApi>()
  const [active, setActive] = useState(0)

  const navigate = useCallback(
    (index: number, direction = 1, focus = false, jump = false) => {
      if (!api || index < 0 || index >= sections.length) return
      const area = scrollAreas.current[index]
      if (!area) return
      area.scrollTo({
        top: getCarouselEntryScrollTop({
          scrollHeight: area.scrollHeight,
          viewportHeight: area.clientHeight,
          direction,
        }),
        behavior: "instant",
      })
      const previous = api.selectedScrollSnap()
      const transferFocus =
        focus || scrollAreas.current[previous]?.contains(document.activeElement)
      if (transferFocus) {
        if (previous === index) area.focus({ preventScroll: true })
        else pendingFocus.current = index
      }
      const instant =
        jump || window.matchMedia("(prefers-reduced-motion: reduce)").matches
      api.scrollTo(index, instant)
    },
    [api]
  )

  useEffect(() => {
    if (pendingFocus.current !== active) return
    scrollAreas.current[active]?.focus({ preventScroll: true })
    pendingFocus.current = null
  }, [active])

  useEffect(() => {
    if (!api || !main.current) return
    const root = main.current
    const indicator = indicators.current
    const page = root.parentElement
    const wheel = createCarouselWheelController({
      getSection() {
        const index = api.selectedScrollSnap()
        const area = scrollAreas.current[index]
        return area
          ? {
              index,
              scrollTop: area.scrollTop,
              scrollHeight: area.scrollHeight,
              viewportHeight: area.clientHeight,
            }
          : null
      },
      onScroll(delta) {
        scrollAreas.current[api.selectedScrollSnap()]?.scrollBy({
          top: delta,
          behavior: "instant",
        })
      },
      onNavigate(direction) {
        navigate(api.selectedScrollSnap() + direction, direction)
      },
    })
    let hideIndicators: ReturnType<typeof setTimeout> | undefined
    let touch: {
      startX: number
      startY: number
      scrollTop: number
      scrollHeight: number
      viewportHeight: number
    } | null = null

    function showIndicators() {
      if (!indicator) return
      indicator.dataset.scrolling = "true"
      clearTimeout(hideIndicators)
      hideIndicators = setTimeout(() => {
        delete indicator.dataset.scrolling
      }, 800)
    }

    function updateSelection() {
      const index = api!.selectedScrollSnap()
      setActive(index)
      const section = scrollAreas.current[index]?.firstElementChild
      if (page && section) {
        page.style.setProperty(
          "--header-background",
          getComputedStyle(section).backgroundColor
        )
        page.dataset.headerSection = sections[index].id
      }
    }

    function syncHash(jump = false) {
      const index = sections.findIndex(
        (section) => `#${section.id}` === window.location.hash
      )
      if (index >= 0) navigate(index, 1, false, jump)
      // Fragment navigation must not add native offsets to Embla's transform.
      api!.rootNode().scrollTo({ top: 0, left: 0, behavior: "instant" })
      root.scrollTo({ top: 0, left: 0, behavior: "instant" })
      page?.scrollTo({ top: 0, left: 0, behavior: "instant" })
    }

    function handleHashChange() {
      syncHash()
    }

    function handleClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return
      const link = event.target.closest<HTMLAnchorElement>("a[href^='#']")
      const index = sections.findIndex(
        (section) => `#${section.id}` === link?.getAttribute("href")
      )
      if (index < 0) return
      event.preventDefault()
      history.pushState(null, "", `#${sections[index].id}`)
      navigate(index, 1, true)
    }

    function handleWheel(event: WheelEvent) {
      if (event.ctrlKey) return
      // Wheel transactions can stay targeted at outgoing section content.
      // Use the pointer's current location instead of that stale event target.
      const hit = document.elementFromPoint(event.clientX, event.clientY)
      if (!hit || !root.contains(hit)) return
      const area = scrollAreas.current[api!.selectedScrollSnap()]
      if (!area) return
      if (event.deltaY && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
        showIndicators()
        // Route pixels to the active section even when the browser has latched
        // its native wheel target to a section that has moved out of view.
        event.preventDefault()
      }
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? area.clientHeight
            : 1
      wheel.feedWheel({
        deltaMode: 0,
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        timeStamp: event.timeStamp,
        momentum: (event as WheelEvent & { momentum?: boolean }).momentum,
      })
    }

    function handleTouchStart(event: TouchEvent) {
      touch = null
      if (event.touches.length !== 1) return
      const area = scrollAreas.current[api!.selectedScrollSnap()]
      if (!area) return
      const point = event.touches[0]
      touch = {
        startX: point.clientX,
        startY: point.clientY,
        scrollTop: area.scrollTop,
        scrollHeight: area.scrollHeight,
        viewportHeight: area.clientHeight,
      }
    }

    function handleTouchEnd(event: TouchEvent) {
      const start = touch
      touch = null
      if (!start || event.touches.length || event.changedTouches.length !== 1)
        return
      const point = event.changedTouches[0]
      const action = getCarouselSwipeAction({
        ...start,
        endX: point.clientX,
        endY: point.clientY,
      })
      if (action === "native") return
      const direction = action === "next" ? 1 : -1
      navigate(api!.selectedScrollSnap() + direction, direction)
    }

    function handleTouchMove(event: TouchEvent) {
      if (!touch || event.touches.length !== 1) return
      const point = event.touches[0]
      const vertical = Math.abs(point.clientY - touch.startY)
      if (vertical > 8 && vertical > Math.abs(point.clientX - touch.startX)) {
        showIndicators()
      }
    }

    function handleTouchCancel() {
      touch = null
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        !(event.target instanceof Element) ||
        event.target.closest(
          "input, textarea, select, [contenteditable='true']"
        )
      )
        return
      if (
        event.key === " " &&
        event.target.closest("button, a, [role='button']")
      )
        return
      const area = scrollAreas.current[api!.selectedScrollSnap()]
      if (!area) return
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault()
        navigate(event.key === "Home" ? 0 : sections.length - 1, 1, true)
        return
      }
      const delta =
        event.key === "ArrowDown"
          ? 40
          : event.key === "ArrowUp"
            ? -40
            : event.key === "PageDown" || (event.key === " " && !event.shiftKey)
              ? area.clientHeight * 0.9
              : event.key === "PageUp" || (event.key === " " && event.shiftKey)
                ? -area.clientHeight * 0.9
                : 0
      if (!delta) return
      event.preventDefault()
      const action = getCarouselScrollAction({
        scrollTop: area.scrollTop,
        scrollHeight: area.scrollHeight,
        viewportHeight: area.clientHeight,
        delta,
      })
      if (action === "native")
        area.scrollBy({ top: delta, behavior: "instant" })
      else
        navigate(
          api!.selectedScrollSnap() + Math.sign(delta),
          Math.sign(delta),
          true
        )
    }

    api.on("select", updateSelection)
    api.on("reInit", updateSelection)
    api.on("scroll", showIndicators)
    root.addEventListener("scroll", showIndicators, {
      capture: true,
      passive: true,
    })
    root.addEventListener("click", handleClick)
    window.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    })
    root.addEventListener("touchstart", handleTouchStart, { passive: true })
    root.addEventListener("touchmove", handleTouchMove, { passive: true })
    root.addEventListener("touchend", handleTouchEnd, { passive: true })
    root.addEventListener("touchcancel", handleTouchCancel, { passive: true })
    root.addEventListener("keydown", handleKeyDown)
    window.addEventListener("hashchange", handleHashChange)
    window.addEventListener("popstate", handleHashChange)
    const frame = requestAnimationFrame(() => {
      syncHash(true)
      updateSelection()
    })
    return () => {
      api.off("select", updateSelection)
      api.off("reInit", updateSelection)
      api.off("scroll", showIndicators)
      root.removeEventListener("scroll", showIndicators, true)
      root.removeEventListener("click", handleClick)
      window.removeEventListener("wheel", handleWheel, true)
      wheel.destroy()
      root.removeEventListener("touchstart", handleTouchStart)
      root.removeEventListener("touchmove", handleTouchMove)
      root.removeEventListener("touchend", handleTouchEnd)
      root.removeEventListener("touchcancel", handleTouchCancel)
      root.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("hashchange", handleHashChange)
      window.removeEventListener("popstate", handleHashChange)
      cancelAnimationFrame(frame)
      clearTimeout(hideIndicators)
      if (indicator) delete indicator.dataset.scrolling
      page?.style.removeProperty("--header-background")
      if (page) delete page.dataset.headerSection
    }
  }, [api, navigate])

  return (
    <main
      ref={main}
      id="main"
      className={cn(styles.sectionsFrame, className)}
      tabIndex={-1}
    >
      <Carousel
        orientation="vertical"
        opts={carouselOptions}
        setApi={setApi}
        className={styles.sections}
        aria-label="Discover Photodepot"
        onKeyDownCapture={undefined}
      >
        <CarouselContent className={styles.sectionTrack}>
          {Children.map(children, (child, index) => (
            <CarouselItem
              className={styles.sectionSlide}
              aria-label={`${sections[index].label}, ${index + 1} of ${sections.length}`}
              aria-hidden={active !== index ? true : undefined}
            >
              <div
                ref={(element) => {
                  scrollAreas.current[index] = element
                }}
                className={styles.sectionScroll}
                data-section-scroll={sections[index].id}
                tabIndex={active === index ? 0 : -1}
              >
                {/* Keep overflow containers available to wheel transactions;
                    only inactive content is inert. */}
                {isValidElement<{ inert?: boolean }>(child)
                  ? cloneElement(child, { inert: active !== index })
                  : child}
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
      </Carousel>
      <nav
        ref={indicators}
        className={styles.sectionNavigation}
        aria-label="Page sections"
      >
        <p
          className={styles.sectionCount}
          aria-label={`Section ${active + 1} of ${sections.length}: ${sections[active].label}`}
          aria-live="polite"
          aria-atomic="true"
        >
          <span>{String(active + 1).padStart(2, "0")}</span>
          <span aria-hidden="true">/</span>
          <span>{String(sections.length).padStart(2, "0")}</span>
        </p>
        <ol className={styles.sectionLinks}>
          {sections.map((section, index) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className={styles.sectionLink}
                aria-label={`Go to ${section.label} section (${index + 1} of ${sections.length})`}
                aria-current={active === index ? "location" : undefined}
              >
                <span className={styles.sectionDot} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </main>
  )
}
