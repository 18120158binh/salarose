import "server-only";
import { readOnly } from "@/lib/db";
import { requireViewer } from "@/widgets/v2-shell/model/viewer";
import {
  catalogAttributesQuery,
  catalogCountQuery,
  catalogPageQuery,
  pageCountOf,
  parseCatalogCount,
  parseCatalogEvents,
  type CatalogPage,
  type CatalogQuery,
} from "./catalog";
import { parsePipelineDashboards, type Dashboard } from "./dashboards";
import { parseSourceKeyRows, SOURCE_KEYS_QUERY, type SourceKeyRow } from "./sourceKeys";

// DHL-NFR-01 gives the catalog view 1 second. A statement that runs past this fails its region.
const STATEMENT_TIMEOUT_MS = 3000;

// DHL-FR-12: every read runs in a read-only transaction. Each loader checks the session itself,
// since the layout's check does not run again on client navigation.

/** DHL-FR-01, DHL-FR-02: one page of the catalog, with the attribute tree of each event on it. */
export async function loadCatalogPage(query: CatalogQuery): Promise<CatalogPage> {
  await requireViewer();
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => {
    const { catalogSize, matching, counts } = parseCatalogCount(await run(catalogCountQuery(query)));
    const pageCount = pageCountOf(matching);
    const page = Math.min(query.page, pageCount);
    const eventRows = matching === 0 ? [] : await run(catalogPageQuery(query, page));
    const ids = eventRows.map((row) => String(row.id));
    const attributeRows = ids.length === 0 ? [] : await run(catalogAttributesQuery(ids));
    return { events: parseCatalogEvents(eventRows, attributeRows), catalogSize, counts, matching, page, pageCount };
  });
}

let dashboards: Dashboard[] | undefined;

// Parsed on the first request rather than at import, so the build never reads the environment.
export function pipelineDashboards(): Dashboard[] {
  dashboards ??= parsePipelineDashboards(process.env.PIPELINE_DASHBOARDS);
  return dashboards;
}

/** DHL-FR-04: the page refuses an editor before it calls this, and this checks the role again. */
export async function loadSourceKeys(): Promise<SourceKeyRow[]> {
  const viewer = await requireViewer();
  if (viewer.role !== "admin") throw new Error("Source keys are for admins.");
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseSourceKeyRows(await run(SOURCE_KEYS_QUERY)));
}
