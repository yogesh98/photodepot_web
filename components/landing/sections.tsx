"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useLandingViewport } from "./scroll-area"
import styles from "./shell.module.css"

export function LandingSections({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const main = useRef<HTMLElement>(null)
  const viewport = useLandingViewport()

  useEffect(() => {
    const root = main.current
    const scroller = viewport.current
    const page = root?.parentElement
    const header = page?.querySelector("header")
    if (!root || !page || !header || !scroller) return

    const sections = Array.from(root.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.tagName === "SECTION"
    )
    let frame = 0

    function updateHeader() {
      frame = 0
      const boundary = header!.getBoundingClientRect().bottom + 1
      let active = sections[0]
      for (const section of sections) {
        if (section.getBoundingClientRect().top > boundary) break
        active = section
      }
      if (!active) return

      page!.style.setProperty(
        "--header-background",
        getComputedStyle(active).backgroundColor
      )
      page!.dataset.headerSection = active.id
    }

    function scheduleUpdate() {
      if (!frame) frame = requestAnimationFrame(updateHeader)
    }

    const resize = new ResizeObserver(scheduleUpdate)
    resize.observe(scroller)
    resize.observe(header)
    sections.forEach((section) => resize.observe(section))
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true })
    updateHeader()

    return () => {
      scroller.removeEventListener("scroll", scheduleUpdate)
      resize.disconnect()
      cancelAnimationFrame(frame)
      page.style.removeProperty("--header-background")
      delete page.dataset.headerSection
    }
  }, [viewport])

  return (
    <main
      ref={main}
      id="main"
      className={cn(styles.sectionsFrame, className)}
      tabIndex={-1}
    >
      {children}
    </main>
  )
}
