"use client"

import Link from "next/link"
import { ExternalLink } from "lucide-react"
import { PhotodepotLogo } from "@/components/photodepot-logo"
import { NavMain, type DashboardNavItem } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { TeamSwitcher, type DashboardMode } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import styles from "./dashboard-frame.module.css"

export function AppSidebar({
  mode,
  items,
  canAccessAdmin,
  email,
  disabled,
}: {
  mode: DashboardMode
  items: DashboardNavItem[]
  canAccessAdmin: boolean
  email?: string
  disabled?: boolean
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          href={mode === "admin" ? "/admin" : "/account"}
          aria-label="Photodepot home"
          className={styles.brand}
        >
          <PhotodepotLogo />
        </Link>
        <TeamSwitcher mode={mode} canAccessAdmin={canAccessAdmin} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain
          label={mode === "admin" ? "Admin navigation" : "Account navigation"}
          items={items}
        />
        <SidebarGroup className="mt-auto">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link href="/" />}
                tooltip="Visit website"
              >
                <ExternalLink />
                <span>Visit website</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser mode={mode} email={email} disabled={disabled} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
