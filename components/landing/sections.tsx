"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import styles from "./shell.module.css"

export function LandingSections({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    const root = main.current
    const page = root?.parentElement
    const header = page?.querySelector("header")
    if (!root || !page || !header) return

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
    resize.observe(header)
    sections.forEach((section) => resize.observe(section))
    window.addEventListener("scroll", scheduleUpdate, { passive: true })
    window.addEventListener("resize", scheduleUpdate)
    updateHeader()

    return () => {
      window.removeEventListener("scroll", scheduleUpdate)
      window.removeEventListener("resize", scheduleUpdate)
      resize.disconnect()
      cancelAnimationFrame(frame)
      page.style.removeProperty("--header-background")
      delete page.dataset.headerSection
    }
  }, [])

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
