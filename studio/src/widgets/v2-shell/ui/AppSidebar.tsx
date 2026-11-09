"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import { entryFor, navFor, type NavEntry, type Reach } from "../model/routes";
import { NAV_ICONS } from "./navIcons";

type SidebarSection = "main" | "data" | "admin";
const SECTION_LABELS: Record<SidebarSection, string | null> = { main: null, data: "Data", admin: "Admin" };
const SECTIONS: readonly SidebarSection[] = ["main", "data", "admin"];

// Shell.dc.html: 13px entries on surface-ink, the current one white and bold on a 10% white wash,
// and a 64px rail whose 40px icons sit centered.
const ENTRY_CLASS =
  "h-9 gap-2.5 rounded-control px-2.5 text-[0.8125rem] text-sidebar-foreground hover:bg-white/6 hover:text-sidebar-accent-foreground data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-3! [&>svg]:size-4.25";
const GROUP_CLASS = "px-3 py-0.5 group-data-[collapsible=icon]:px-3";
const LABEL_CLASS = "h-auto px-2.5 pt-3.5 pb-1 font-semibold text-[0.65625rem] text-sidebar-foreground/75 uppercase tracking-[0.11em]";

export function AppSidebar({ viewer }: { viewer: Reach }) {
  const pathname = usePathname();
  const current = entryFor(pathname)?.id;
  const entries = navFor(viewer);

  return (
    <Sidebar collapsible="icon" className="border-sidebar-border">
      <SidebarHeader className="px-5 pt-4 pb-2 group-data-[collapsible=icon]:px-4.5">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <BrandMark />
          <span className="truncate font-heading font-semibold text-[0.9375rem] text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden">
            Salarose
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="py-2">
        <nav aria-label="Studio" className="flex flex-col gap-1">
          {SECTIONS.map((section) => {
            const items = entries.filter((entry) => entry.section === section);
            if (items.length === 0) return null;
            const label = SECTION_LABELS[section];
            return (
              <SidebarGroup key={section} className={GROUP_CLASS}>
                {label && <SidebarGroupLabel className={LABEL_CLASS}>{label}</SidebarGroupLabel>}
                <SidebarMenu>
                  {items.map((entry) => (
                    <NavItem key={entry.id} entry={entry} active={entry.id === current} />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            );
          })}
        </nav>
      </SidebarContent>
      <SidebarFooter className="px-3 pb-4 group-data-[collapsible=icon]:px-3">
        <CollapseButton />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// The Salarose mark: a rose-sun half disc on a white horizon with its reflection, on a teal tile.
// It is the brand asset, so it keeps its own colors in both themes.
function BrandMark() {
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-control bg-[#0e6f6a]">
      <svg fill="none" height="14" viewBox="0 0 14 14" width="14">
        <path d="M3 8a4 4 0 0 1 8 0Z" fill="#f8a868" />
        <path d="M3 8a4 4 0 0 0 8 0Z" fill="#f8a868" opacity=".45" />
        <path d="M1.5 8h11" stroke="#ffffff" strokeLinecap="round" strokeWidth="1.3" />
      </svg>
    </span>
  );
}

function CollapseButton() {
  const { state, toggleSidebar, isMobile } = useSidebar();
  if (isMobile) return null;
  const collapsed = state === "collapsed";
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton className={ENTRY_CLASS} onClick={toggleSidebar} tooltip={collapsed ? "Expand sidebar" : undefined} type="button">
          <Icon aria-hidden />
          <span>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function NavItem({ entry, active }: { entry: NavEntry; active: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const Icon = NAV_ICONS[entry.id];
  const preview = entry.stage === "preview";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={ENTRY_CLASS}
        isActive={active}
        render={
          <Link
            aria-current={active ? "page" : undefined}
            href={entry.href}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
          />
        }
        tooltip={preview ? `${entry.label}, preview` : entry.label}
      >
        <Icon aria-hidden />
        {preview && (
          <span aria-hidden className="absolute top-2 right-2 hidden size-1.5 rounded-full bg-sidebar-ring group-data-[collapsible=icon]:block" />
        )}
        <span>{entry.label}</span>
      </SidebarMenuButton>
      {preview && (
        <SidebarMenuBadge className="right-2 peer-data-[size=default]/menu-button:top-2.5">
          <PreviewBadge on="sidebar" />
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}
