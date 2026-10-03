"use client"

import { ArrowUpRight } from "lucide-react"
import type { ReactNode } from "react"
import { WaitlistProvider, WaitlistTrigger } from "@/components/waitlist-button"

export function LandingWaitlist({ children }: { children: ReactNode }) {
  return <WaitlistProvider>{children}</WaitlistProvider>
}

export function LandingWaitlistTrigger({
  appearance = "primary",
  showArrow = true,
}: {
  appearance?: "primary" | "quiet"
  showArrow?: boolean
}) {
  return (
    <WaitlistTrigger
      className="landing-waitlist-button"
      data-appearance={appearance}
      render={<button type="button" />}
    >
      Join the waitlist
      {showArrow && (
        <ArrowUpRight size={16} strokeWidth={1.5} aria-hidden="true" />
      )}
    </WaitlistTrigger>
  )
}
