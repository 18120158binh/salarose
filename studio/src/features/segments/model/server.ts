import "server-only";
import { notFound } from "next/navigation";
import { getSegmentDetail, getUserEvents, listSegmentSummaries } from "@/lib/db";
import { formatTimestamp } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { SEGMENT_EDITOR, stageLets, type Viewer } from "@/widgets/v2-shell/model/routes";
import { requireViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";
import { parseSegmentId, type SegmentId } from "shared/lib/segments";
import type { UserEventDef } from "shared/types";
import { emptySegmentDraft, segmentDraft, type SegmentDraft } from "./segmentDraft";
import { journeyUses, segmentRows, UNKNOWN_CREATOR, type JourneyUse, type SegmentDetails, type SegmentRow } from "./segmentList";

// SEG-FR-09: the rows of /v2/segments, with each last change told relative to now.
// SEG-NFR-02: the layout's session check does not run again on client navigation, so the loader
// checks the session itself before it reads.
export async function loadSegmentRows(zone: TimeZone): Promise<SegmentRow[]> {
  const viewer = await requireViewer();
  return segmentRows(await listSegmentSummaries(), Date.now(), zone, viewer);
}

// SEG-FR-01, SHL-FR-22: the editor pages open only to viewers at the editor's stage. Anyone else
// gets the not-found page before any data is read.
export async function requireSegmentEditor(): Promise<Viewer> {
  const [viewer, reach] = await Promise.all([requireViewer(), viewerReach()]);
  if (!stageLets(SEGMENT_EDITOR.stage, reach.preview)) notFound();
  return viewer;
}

export interface SegmentEditorData {
  initial: SegmentDraft;
  usedBy: JourneyUse[];
  events: UserEventDef[];
  details: SegmentDetails | null;
}

export async function loadNewSegment(): Promise<SegmentEditorData> {
  await requireSegmentEditor();
  return { initial: emptySegmentDraft(), usedBy: [], events: await getUserEvents(), details: null };
}

// Null when no segment has the id, for the page to render not-found.
export async function loadSegmentForEdit(rawId: string, zone: TimeZone): Promise<SegmentEditorData | null> {
  const viewer = await requireSegmentEditor();
  let id: SegmentId;
  try {
    id = parseSegmentId(rawId);
  } catch {
    return null;
  }
  const [segment, events] = await Promise.all([getSegmentDetail(id), getUserEvents()]);
  if (!segment) return null;
  const now = Date.now();
  const at = (text: string | null) => {
    const time = text === null ? Number.NaN : Date.parse(text);
    return Number.isNaN(time) ? null : formatTimestamp(time, now, zone);
  };
  return {
    initial: segmentDraft(segment),
    usedBy: journeyUses(segment.usedBy, viewer),
    events,
    details: { createdBy: segment.createdBy ?? UNKNOWN_CREATOR, created: at(segment.createdAt), lastChange: at(segment.updatedAt) },
  };
}
