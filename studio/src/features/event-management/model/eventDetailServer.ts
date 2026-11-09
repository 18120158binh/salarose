import "server-only";
import { getUserEventFieldUses, getUserEventSegments, getUserEventUsage, readOnly } from "@/lib/db";
import { requireViewer } from "@/widgets/v2-shell/model/viewer";
import { eventDetailAttributesQuery, eventDetailQuery, parseEventDetail, type EventDetailPage } from "./eventDetail";

const STATEMENT_TIMEOUT_MS = 3000;

/**
 * CAT-FR-10, CAT-FR-20, DHL-FR-02: one event with its fields, its uses, and the uses of each field,
 * for any staff user, or null when no event has the id. It checks the session itself, since the
 * layout's check does not run again on client navigation. Every statement only reads.
 */
export async function loadEventDetail(id: string): Promise<EventDetailPage | null> {
  await requireViewer();
  const event = await readOnly(STATEMENT_TIMEOUT_MS, async (run) =>
    parseEventDetail(await run(eventDetailQuery(id)), await run(eventDetailAttributesQuery(id))),
  );
  if (event === null) return null;
  const [uses, segments, fieldUses] = await Promise.all([getUserEventUsage(id), getUserEventSegments(id), getUserEventFieldUses(id)]);
  return { event, uses, segments, fieldUses };
}
