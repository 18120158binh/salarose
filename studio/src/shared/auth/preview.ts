import "server-only";
import { notFound } from "next/navigation";
import * as db from "@/lib/db";
import { requireSession } from "./session";
import type { AdminSession } from "./types";

// SHL-FR-22: a preview viewer is an admin, or a staff user whose system_users.preview is true.
// The flag is read on every call, so a change applies at the user's next request.
export async function isPreviewViewer(session: AdminSession): Promise<boolean> {
  return session.role === "admin" || (await db.getSystemUserPreview(session.userId));
}

// For a page or loader at stage preview. Anyone else gets the not-found page, as for a route that
// does not exist, before the page reads any data. The route's own role check still applies.
export async function requirePreviewViewer(): Promise<AdminSession> {
  const session = await requireSession();
  if (!(await isPreviewViewer(session))) notFound();
  return session;
}
