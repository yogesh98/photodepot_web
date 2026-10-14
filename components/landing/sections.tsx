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
    const documentRoot = root.ownerDocument.documentElement
    documentRoot.dataset.landingScrollbar = ""

    const sections = Array.from(root.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.tagName === "SECTION"
    )
    let frame = 0

    function updateSurfaces() {
      frame = 0
      const headerBottom = header!.getBoundingClientRect().bottom
      const surfaces = sections.map((section) => ({
        section,
        bounds: section.getBoundingClientRect(),
        background: getComputedStyle(section).backgroundColor,
      }))
      let active = surfaces[0]
      for (const surface of surfaces) {
        if (surface.bounds.top > headerBottom + 1) break
        active = surface
      }
      if (!active) return

      page!.style.setProperty("--header-background", active.background)
      page!.dataset.headerSection = active.section.id
      documentRoot.style.setProperty(
        "--landing-scrollbar-color",
        active.background
      )

      // Classic scrollbar gutters reveal the root canvas, not child sections.
      // Mirror the visible surfaces there, including the sticky header.
      const stops = [`${active.background} 0px ${headerBottom}px`]
      for (const { bounds, background } of surfaces) {
        const top = Math.max(headerBottom, bounds.top)
        const bottom = Math.min(window.innerHeight, bounds.bottom)
        if (bottom > top) stops.push(`${background} ${top}px ${bottom}px`)
      }
      documentRoot.style.setProperty(
        "--landing-scrollbar-background",
        `linear-gradient(to bottom, ${stops.join(", ")})`
      )
    }

    function scheduleUpdate() {
      if (!frame) frame = requestAnimationFrame(updateSurfaces)
    }

    const resize = new ResizeObserver(scheduleUpdate)
    resize.observe(header)
    sections.forEach((section) => resize.observe(section))
    window.addEventListener("scroll", scheduleUpdate, { passive: true })
    window.addEventListener("resize", scheduleUpdate)
    updateSurfaces()

    return () => {
      window.removeEventListener("scroll", scheduleUpdate)
      window.removeEventListener("resize", scheduleUpdate)
      resize.disconnect()
      cancelAnimationFrame(frame)
      page.style.removeProperty("--header-background")
      delete page.dataset.headerSection
      documentRoot.style.removeProperty("--landing-scrollbar-background")
      documentRoot.style.removeProperty("--landing-scrollbar-color")
      delete documentRoot.dataset.landingScrollbar
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
