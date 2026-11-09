"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ToastProvider } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { TimeZone } from "@/shared/lib/time-range";
import { tzCookie } from "../model/preferences";
import type { Reach } from "../model/routes";
import { AppSidebar } from "./AppSidebar";
import { ClassicPageProvider } from "./ClassicPage";
import type { SearchNames } from "./CommandPalette";
import { TopBar } from "./TopBar";

export interface V2ShellProps {
  workspace: string;
  email: string;
  viewer: Reach;
  // The collapsed state the browser remembered, read from the sidebar's cookie.
  sidebarOpen: boolean;
  // The zone the server rendered in, read from the tz cookie.
  zone: TimeZone;
  // The command palette's journey and segment search, a server action.
  searchNames: SearchNames;
  children: ReactNode;
}

const CONTENT_ID = "v2-content";

const SIZES = { "--sidebar-width": "240px", "--sidebar-width-icon": "64px" } as CSSProperties;

export function V2Shell({ workspace, email, viewer, sidebarOpen, zone, searchNames, children }: V2ShellProps) {
  useBrowserTimeZone(zone);
  // SHL-NFR-04: from 768 to 1023 px the sidebar starts collapsed, whatever the wide layout remembers.
  const tablet = useMediaQuery("(min-width: 768px) and (max-width: 1023px)");
  const [wideOpen, setWideOpen] = useState(sidebarOpen);
  const [tabletOpen, setTabletOpen] = useState(false);

  return (
    <ToastProvider>
      <ClassicPageProvider>
        <SidebarProvider
          className="h-svh min-h-0 overflow-hidden"
          data-salarose=""
          onOpenChange={tablet ? setTabletOpen : setWideOpen}
          open={tablet ? tabletOpen : wideOpen}
          style={SIZES}
        >
          {/* SHL-NFR-02: the first Tab stop jumps past the sidebar and the top bar. */}
          <a
            className="sr-only z-50 rounded-md bg-background px-3 py-2 font-medium text-sm shadow-md outline-none focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:ring-2 focus-visible:ring-ring"
            href={`#${CONTENT_ID}`}
          >
            Skip to content
          </a>
          <AppSidebar viewer={viewer} />
          {/* The root layout already renders the page's <main>, so this is a plain container. */}
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <TopBar email={email} searchNames={searchNames} viewer={viewer} workspace={workspace} />
            <div className="flex-1 overflow-y-auto outline-none" id={CONTENT_ID} tabIndex={-1}>
              <div className="flex min-h-full flex-col gap-6 p-6 min-[1440px]:p-8">{children}</div>
            </div>
          </div>
        </SidebarProvider>
      </ClassicPageProvider>
    </ToastProvider>
  );
}

// SHL-FR-15: write the browser's zone on every v2 page load. When the server rendered in another
// zone, as on a first visit, refresh the data once. If the zone still differs after that, as when
// cookies are blocked, the page stays in the server's zone.
function useBrowserTimeZone(zone: TimeZone) {
  const router = useRouter();
  const refreshed = useRef(false);

  useEffect(() => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserZone) return;
    document.cookie = tzCookie(browserZone);
    if (browserZone !== zone && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [zone, router]);
}
