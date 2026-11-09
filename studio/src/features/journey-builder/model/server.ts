import "server-only";
import * as db from "@/lib/db";
import { getMyDraft } from "@/features/journeys/model/drafts";
import { stageLets, JOURNEY_BUILDER } from "@/widgets/v2-shell/model/routes";
import { requireViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";
import type { BuilderDraft, CatalogEvent } from "../ui/JourneyBuilder";

// JBD-NFR-01, SHL-FR-22: the builder opens the viewer's own draft, and only while its stage lets
// the viewer through. Anyone else, an admin included, gets null, which the page shows as "This
// journey does not exist."
export async function openDraft(id: string): Promise<BuilderDraft | null> {
  const [viewer, reach] = await Promise.all([requireViewer(), viewerReach()]);
  if (!stageLets(JOURNEY_BUILDER.stage, reach.preview)) return null;
  const [draft, events] = await Promise.all([getMyDraft(viewer.userId, id), catalogEvents()]);
  if (draft === null) return null;
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    version: draft.version,
    root: draft.root,
    savedAt: Date.parse(draft.updatedAt),
    events,
  };
}

// Without the catalog the builder still opens, and the event pickers are empty.
async function catalogEvents(): Promise<CatalogEvent[]> {
  try {
    return (await db.getUserEvents()).map((event) => ({ name: event.name, label: event.label }));
  } catch (error) {
    console.error("Failed to load the event catalog:", error);
    return [];
  }
}
