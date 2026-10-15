"use client"

import { Check, ChevronsUpDown, ShieldCheck, UserRound } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export type DashboardMode = "admin" | "individual"

/** sidebar-07's team switcher, using the two authorized Photodepot dashboards. */
export function TeamSwitcher({
  mode,
  canAccessAdmin,
}: {
  mode: DashboardMode
  canAccessAdmin: boolean
}) {
  const { isMobile } = useSidebar()
  if (!canAccessAdmin) return null
  const active = mode === "admin" ? "Admin dashboard" : "Individual dashboard"
  const ActiveIcon = mode === "admin" ? ShieldCheck : UserRound
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Switch dashboard"
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              />
            }
          >
            <div className="flex aspect-square size-8 items-center justify-center border border-sidebar-border">
              <ActiveIcon className="size-4" />
            </div>
            <span className="flex-1 truncate font-medium">{active}</span>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuItem
                render={<a href="/account" />}
                className="gap-2 p-2"
              >
                <UserRound />
                Individual dashboard
                {mode === "individual" && <Check className="ml-auto" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<a href="/admin" />}
                className="gap-2 p-2"
              >
                <ShieldCheck />
                Admin dashboard
                {mode === "admin" && <Check className="ml-auto" />}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
