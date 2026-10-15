"use client"

import { ChevronsUpDown, LogOut, UserRound } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { DashboardMode } from "./team-switcher"

export function NavUser({
  email,
  mode,
  disabled,
}: {
  email?: string
  mode: DashboardMode
  disabled?: boolean
}) {
  const { isMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Account menu"
            render={
              <SidebarMenuButton size="lg" className="aria-expanded:bg-muted" />
            }
          >
            <Avatar>
              <AvatarFallback>
                {email ? email.charAt(0).toUpperCase() : <UserRound />}
              </AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate text-left text-xs">
              {email || "Account"}
            </span>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "top" : "right"}
            align="end"
            sideOffset={4}
          >
            {email && (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="truncate">
                    {email}
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuGroup>
              <DropdownMenuItem render={<a href="/account" />}>
                <UserRound />
                Your account
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <form
              action={
                mode === "admin"
                  ? "/api/auth/logout"
                  : "/api/account/auth/logout"
              }
              method="post"
            >
              <DropdownMenuItem
                render={<button type="submit" />}
                disabled={disabled}
              >
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
