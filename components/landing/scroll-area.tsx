"use client"

import { ScrollArea } from "@base-ui/react/scroll-area"
import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from "react"
import styles from "./shell.module.css"

const LandingViewportContext =
  createContext<RefObject<HTMLDivElement | null> | null>(null)

export function useLandingViewport() {
  const viewport = useContext(LandingViewportContext)
  if (!viewport) throw new Error("Landing content requires a scroll viewport.")
  return viewport
}

export function LandingScrollArea({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null)

  return (
    <LandingViewportContext.Provider value={viewport}>
      <ScrollArea.Root className={styles.scrollArea}>
        <ScrollArea.Viewport
          ref={viewport}
          className={styles.scrollViewport}
          data-landing-viewport=""
          role="region"
          aria-label="Photodepot page"
        >
          <ScrollArea.Content className={styles.page} style={{ minWidth: 0 }}>
            {children}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className={styles.scrollbar}>
          <ScrollArea.Thumb className={styles.scrollThumb} />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </LandingViewportContext.Provider>
  )
}
