"use server";

import { revalidatePath } from "next/cache";
import { deleteSegment, saveSegment } from "@/lib/db";
import { isPreviewViewer } from "@/shared/auth/preview";
import { assertSession } from "@/shared/auth/session";
import { classicHref, stageLets, SEGMENT_EDITOR } from "@/widgets/v2-shell/model/routes";
import { parseSegmentId, parseSegmentInput, type SegmentUse } from "shared/lib/segments";
import { userFacingMessage } from "shared/lib/userFacingError";

// The studio v2 segment actions (SEG-FR-01). Each checks the session itself and the editor's stage
// (SEG-NFR-02, SHL-FR-22): any staff user who may reach the editor may act, and no action needs
// the admin role.

type Failed = { error: string };

async function run<T>(action: string, work: (userId: string) => Promise<T>): Promise<T | Failed> {
  try {
    const session = await assertSession();
    if (!stageLets(SEGMENT_EDITOR.stage, await isPreviewViewer(session))) {
      return { error: "Changing segments here is in preview. Change them in the classic studio." };
    }
    return await work(session.userId);
  } catch (error) {
    console.error(`Failed to ${action}:`, error);
    return { error: userFacingMessage(error, `Failed to ${action}.`) };
  }
}

// The classic segments page reads the same rows until cutover, so it reloads too.
function refresh() {
  revalidatePath("/v2/segments");
  revalidatePath(classicHref("/v2/segments", "editor"));
}

export type SaveOutcome = { saved: true; id: string } | { confirm: SegmentUse[] } | Failed;

// SEG-FR-07: an edit that active campaigns use returns them until each is confirmed.
export async function saveSegmentV2Action(input: unknown, confirmedCampaignIds: unknown = []): Promise<SaveOutcome> {
  return run("save the segment", async (userId) => {
    const confirmed = Array.isArray(confirmedCampaignIds)
      ? confirmedCampaignIds.filter((id): id is string => typeof id === "string")
      : [];
    const result = await saveSegment(parseSegmentInput(input), userId, confirmed);
    if (!result.saved) return { confirm: result.confirm };
    refresh();
    return { saved: true as const, id: result.id };
  });
}

// SEG-FR-04: the store refuses while an active or paused campaign uses the segment.
export async function deleteSegmentV2Action(segmentId: unknown): Promise<{ deleted: true } | Failed> {
  return run("delete the segment", async () => {
    await deleteSegment(parseSegmentId(segmentId));
    refresh();
    return { deleted: true as const };
  });
}
