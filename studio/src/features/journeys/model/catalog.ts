import "server-only";
import { readOnly } from "@/lib/db";
import { requireViewer } from "@/widgets/v2-shell/model/viewer";

/** A catalog event a template's event can map to. */
export interface CatalogEvent {
  readonly name: string;
  readonly label: string;
}

const CATALOG_TIMEOUT_MS = 5000;

/** The active events of the catalog, by label, for the template dialog's pickers (JBD-FR-29). */
export async function loadCatalogEvents(): Promise<CatalogEvent[]> {
  await requireViewer();
  return readOnly(CATALOG_TIMEOUT_MS, async (run) => {
    const rows = await run({
      text: "SELECT event_name, display_name FROM user_events WHERE status = 'active' ORDER BY COALESCE(NULLIF(display_name, ''), event_name), event_name",
      values: [],
    });
    return rows.flatMap((row) =>
      typeof row.event_name === "string"
        ? [{ name: row.event_name, label: typeof row.display_name === "string" && row.display_name !== "" ? row.display_name : row.event_name }]
        : [],
    );
  });
}
