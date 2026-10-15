"use client"

import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"

export type DashboardNavItem = {
  title: string
  icon: ReactNode
  url?: string
  isActive?: boolean
  badge?: number
  onSelect?: () => void
  items?: {
    title: string
    url?: string
    isActive?: boolean
    onSelect?: () => void
  }[]
}
export function NavMain({
  items,
  label,
}: {
  items: DashboardNavItem[]
  label: string
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const select = (callback?: () => void) => {
    callback?.()
    if (isMobile) setOpenMobile(false)
  }
  return (
    <nav aria-label={label}>
      <SidebarGroup>
        <SidebarMenu>
          {items.map((item) =>
            item.items?.length ? (
              <Collapsible
                key={item.title}
                defaultOpen={item.isActive}
                className="group/collapsible"
                render={<SidebarMenuItem />}
              >
                <CollapsibleTrigger
                  render={
                    <SidebarMenuButton
                      tooltip={item.title}
                      isActive={item.isActive}
                    />
                  }
                >
                  {item.icon}
                  <span>{item.title}</span>
                  <ChevronRight className="ml-auto transition-transform duration-200 group-data-open/collapsible:rotate-90" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items.map((sub) => (
                      <SidebarMenuSubItem key={sub.title}>
                        <SidebarMenuSubButton
                          render={
                            sub.url ? (
                              <a href={sub.url} />
                            ) : (
                              <button type="button" />
                            )
                          }
                          isActive={sub.isActive}
                          onClick={() => select(sub.onSelect)}
                        >
                          <span>{sub.title}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  tooltip={item.title}
                  isActive={item.isActive}
                  aria-current={item.isActive ? "page" : undefined}
                  render={item.url ? <a href={item.url} /> : undefined}
                  onClick={() => select(item.onSelect)}
                >
                  {item.icon}
                  <span>{item.title}</span>
                </SidebarMenuButton>
                {item.badge !== undefined && item.badge > 0 && (
                  <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            )
          )}
        </SidebarMenu>
      </SidebarGroup>
    </nav>
  )
}
