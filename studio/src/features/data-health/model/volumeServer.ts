import "server-only";
import { readOnly } from "@/lib/db";
import type { TimeZone } from "@/shared/lib/time-range";
import { requireViewer } from "@/widgets/v2-shell/model/viewer";
import {
  lastSeenQuery,
  parseLastSeenRows,
  parseVolumeRows,
  summarizeEventVolume,
  volumeRowsQuery,
  type EventVolume,
  type VolumeWindow,
} from "./eventVolume";
import { CATALOG_EVENT_NAMES_QUERY, eventHealth, parseCatalogEventNames, type EventHealth } from "./eventHealth";
import { metricCreatorsQuery, parseMetricCreators, type MetricCreator } from "./metricCreators";

const STATEMENT_TIMEOUT_MS = 3000;

// SHL-FR-15: the window counts days in the viewer's zone, the same zone the page names.
// Every read runs in a read-only transaction and checks the session itself, as the catalog's do.

/** Per-event volume, drops, and last seen for the named events, in the order given. */
export async function loadEventVolumes(eventNames: readonly string[], window: VolumeWindow, zone: TimeZone): Promise<EventVolume[]> {
  await requireViewer();
  if (eventNames.length === 0) return [];
  const now = Date.now();
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => {
    const rows = parseVolumeRows(await run(volumeRowsQuery(eventNames, now)));
    const lastSeen = parseLastSeenRows(await run(lastSeenQuery(eventNames)));
    return summarizeEventVolume(eventNames, rows, lastSeen, window, now, zone);
  });
}

/** DHL-FR-13, DHL-FR-14: every catalog event with its volume in the window. */
export async function loadEventHealth(window: VolumeWindow, zone: TimeZone): Promise<EventHealth> {
  await requireViewer();
  const now = Date.now();
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => {
    const events = parseCatalogEventNames(await run(CATALOG_EVENT_NAMES_QUERY));
    if (events.length === 0) return eventHealth([], []);
    const names = events.map((event) => event.name);
    const rows = parseVolumeRows(await run(volumeRowsQuery(names, now)));
    const lastSeen = parseLastSeenRows(await run(lastSeenQuery(names)));
    return eventHealth(events, summarizeEventVolume(names, rows, lastSeen, window, now, zone));
  });
}

/** The creator of each named metric that exists. */
export async function loadMetricCreators(metricIds: readonly string[]): Promise<MetricCreator[]> {
  await requireViewer();
  if (metricIds.length === 0) return [];
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseMetricCreators(await run(metricCreatorsQuery(metricIds))));
}
