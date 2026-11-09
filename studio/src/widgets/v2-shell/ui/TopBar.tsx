"use client";

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDownIcon, CircleUserIcon, LogOutIcon, Undo2Icon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { SystemRole } from "@/shared/auth/types";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import { initials } from "../model/preferences";
import { classicHref, entryFor, mayReach, NAV, type NavSection, type Reach } from "../model/routes";
import { useClassicPage } from "./ClassicPage";
import { CommandPalette, type SearchNames } from "./CommandPalette";

const ROLE_LABELS: Record<SystemRole, string> = { admin: "Admin", editor: "Editor" };

export interface TopBarProps {
  workspace: string;
  email: string;
  viewer: Reach;
  searchNames: SearchNames;
}

export function TopBar({ workspace, email, viewer, searchNames }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:px-7">
      <SidebarTrigger className="-ml-1 size-8 text-muted-foreground hover:text-foreground md:hidden" />
      <Breadcrumb workspace={workspace} />
      <div className="ml-auto flex items-center gap-3">
        <CommandPalette search={searchNames} viewer={viewer} />
        <AccountMenu email={email} viewer={viewer} />
      </div>
    </header>
  );
}

const SECTION_NAMES: Partial<Record<NavSection, string>> = { data: "Data" };

// Shell.dc.html: the workspace, the sidebar group, and the current page, as the top bar's trail.
function Breadcrumb({ workspace }: { workspace: string }) {
  const page = entryFor(usePathname());
  const section = page ? SECTION_NAMES[page.section] : undefined;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-[0.8125rem]">
      <span className="truncate">{workspace}</span>
      {section && (
        <>
          <span aria-hidden>/</span>
          <span className="hidden sm:inline">{section}</span>
        </>
      )}
      {page && (
        <>
          <span aria-hidden>/</span>
          <span aria-current="page" className="truncate font-semibold text-foreground">
            {page.label}
          </span>
        </>
      )}
    </nav>
  );
}

export function AccountMenu({ email, viewer }: { email: string; viewer: Reach }) {
  const pathname = usePathname();
  const classicPage = useClassicPage();
  const signOut = useRef<HTMLFormElement>(null);
  const account = NAV.find((entry) => entry.id === "account");
  const showAccount = account !== undefined && mayReach(account, viewer);

  return (
    <>
      <form ref={signOut} action="/api/auth/logout" method="post" hidden />
      <Menu>
        <MenuTrigger
          aria-label="Account"
          className="flex items-center gap-2 rounded-full border border-input bg-popover py-0.5 ps-0.5 pe-2.5 text-[0.8125rem] outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:border-primary"
        >
          <Avatar className="size-6.5">
            <AvatarFallback className="bg-primary font-semibold text-[0.6875rem] text-primary-foreground">{initials(email)}</AvatarFallback>
          </Avatar>
          <span className="hidden sm:inline">{ROLE_LABELS[viewer.role]}</span>
          <ChevronDownIcon aria-hidden className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-68">
          <MenuGroup>
            <MenuGroupLabel className="flex flex-col items-start gap-0.5 py-2">
              <span className="max-w-full truncate font-semibold text-foreground text-sm">{email}</span>
              <span className="flex items-center gap-1.5 font-normal text-muted-foreground text-xs">
                <span>{ROLE_LABELS[viewer.role]}</span>
                <span aria-hidden>·</span>
                <span>Preview access: {viewer.preview ? "on" : "off"}</span>
              </span>
            </MenuGroupLabel>
          </MenuGroup>
          <MenuSeparator />
          {showAccount && (
            <MenuItem render={<Link href={account.href} />}>
              <CircleUserIcon aria-hidden />
              Account
              {account.stage === "preview" && <PreviewBadge className="ms-auto" />}
            </MenuItem>
          )}
          <MenuItem render={<a href={classicPage ?? classicHref(pathname, viewer.role)} />}>
            <Undo2Icon aria-hidden />
            Back to classic
            <span aria-hidden className="ms-auto text-muted-foreground text-xs">
              until switch-over
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => signOut.current?.requestSubmit()}>
            <LogOutIcon aria-hidden />
            Sign out
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
