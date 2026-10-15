"use client"

import { useEffect, useState, type ReactNode } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import type { DashboardNavItem } from "@/components/nav-main"
import type { DashboardMode } from "@/components/team-switcher"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import styles from "./dashboard-frame.module.css"

type DashboardAccess = {
  user: { id: string; email: string }
  canAccessAdmin: boolean
}
export function DashboardFrame({
  mode,
  items,
  email,
  disabled,
  className,
  children,
}: {
  mode: DashboardMode
  items: DashboardNavItem[]
  email?: string
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const [access, setAccess] = useState<DashboardAccess | null>(null)
  useEffect(() => {
    let disposed = false
    let active: AbortController | null = null
    const load = async () => {
      active?.abort()
      active = new AbortController()
      const controller = active
      try {
        const response = await fetch(
          `/api/account/dashboard-access?dashboard=${mode}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          }
        )
        if (!response.ok) throw new Error("Dashboard access unavailable")
        const result = await response.json()
        if (
          !result?.user ||
          typeof result.user.email !== "string" ||
          typeof result.user.id !== "string" ||
          typeof result.canAccessAdmin !== "boolean"
        )
          throw new Error("Invalid dashboard access")
        if (!disposed && !controller.signal.aborted) setAccess(result)
      } catch {
        if (!disposed && !controller.signal.aborted) setAccess(null)
      }
    }
    void load()
    const refresh = () => {
      if (document.visibilityState === "visible") void load()
    }
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      disposed = true
      active?.abort()
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [mode])
  return (
    <TooltipProvider>
      <SidebarProvider className={`${styles.frame} ${className ?? ""}`}>
        <AppSidebar
          mode={mode}
          items={items}
          canAccessAdmin={access?.canAccessAdmin === true}
          email={access?.user.email || email}
          disabled={disabled}
        />
        <SidebarInset className={styles.inset}>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
