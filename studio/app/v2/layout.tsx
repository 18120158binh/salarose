import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { parseSidebarOpen, SIDEBAR_COOKIE, workspaceName } from "@/widgets/v2-shell/model/preferences";
import { requireViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";
import { SalaroseFonts } from "@/widgets/v2-shell/ui/SalaroseFonts";
import { V2Shell } from "@/widgets/v2-shell/ui/V2Shell";
import { searchPaletteNames } from "./actions";

export const metadata = { title: "Salarose" };

// The proxy already sends a request without a session cookie to /login with its return path
// (SHL-FR-02). This check catches a cookie whose user was removed or signed out elsewhere.
export default async function V2Layout({ children }: { children: ReactNode }) {
  const [viewer, reach, cookieStore] = await Promise.all([requireViewer(), viewerReach(), cookies()]);

  return (
    <>
      <SalaroseFonts />
      <V2Shell
        email={viewer.email}
        searchNames={searchPaletteNames}
        sidebarOpen={parseSidebarOpen(cookieStore.get(SIDEBAR_COOKIE)?.value)}
        viewer={reach}
        workspace={workspaceName(process.env.STUDIO_WORKSPACE_NAME)}
        zone={parseTimeZone(cookieStore.get(TZ_COOKIE)?.value)}
      >
        {children}
      </V2Shell>
    </>
  );
}
