import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { isPreviewViewer } from "@/shared/auth/preview";
import { requireSession } from "@/shared/auth/session";
import { toCheckedAdmin, type AdminSession, type CheckedAdmin } from "@/shared/auth/types";
import { mayOpen, NAV, stageLets, type NavId, type Reach } from "./routes";

// The layout and the page both need the viewer. One session lookup per request serves both.
export const requireViewer: () => Promise<AdminSession> = cache(requireSession);

// SHL-FR-03: an admin page renders the forbidden state for anyone else, before it loads any data.
export async function adminViewer(): Promise<CheckedAdmin | null> {
  return toCheckedAdmin(await requireViewer());
}

// The preview flag is read once per request, and on every request, so a change applies at the
// viewer's next one (SHL-FR-22).
export const viewerReach: () => Promise<Reach> = cache(async () => {
  const viewer = await requireViewer();
  return { role: viewer.role, preview: await isPreviewViewer(viewer) };
});

/**
 * The route guard for a page of the route table. A reserved route, or a preview route the viewer
 * may not reach, gets the not-found page, as for a route that does not exist (SHL-FR-01,
 * SHL-FR-22). A route the role may not open returns null, for the page to render the forbidden
 * state (SHL-FR-03). Both happen before the page reads any data.
 */
export async function openRoute(id: NavId): Promise<AdminSession | null> {
  const route = NAV.find((entry) => entry.id === id);
  if (!route) notFound();
  const [viewer, reach] = await Promise.all([requireViewer(), viewerReach()]);
  if (!stageLets(route.stage, reach.preview)) notFound();
  return mayOpen(route.access, viewer.role) ? viewer : null;
}
