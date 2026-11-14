"use server";

import { assertSession } from "@/shared/auth/session";
import { loadNodeCompleted } from "./server";

export type NodeCompletedRefresh =
  { completed: Record<string, number>; readAt: number } | { error: string };

// JBD-FR-09: the Journey tab's 5 second refresh. It checks the session itself, like every action,
// and a failure comes back as a result, so that the tab keeps its last counts.
export async function refreshNodeCompletedAction(
  campaignId: unknown,
): Promise<NodeCompletedRefresh> {
  try {
    await assertSession();
    if (typeof campaignId !== "string" || campaignId === "")
      return { error: "No journey id." };
    return {
      completed: await loadNodeCompleted(campaignId),
      readAt: Date.now(),
    };
  } catch (error) {
    console.error("Failed to refresh the journey's counts:", error);
    return { error: "Counts could not refresh." };
  }
}
