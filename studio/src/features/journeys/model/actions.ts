"use server";

import { revalidatePath } from "next/cache";
import { campaignActor, deleteCampaign, updateCampaignStatus } from "@/lib/db";
import { loadPeopleWaiting } from "@/features/journey-analytics/model/server";
import { assertSession } from "@/shared/auth/session";
import type { AdminSession } from "@/shared/auth/types";
import { userFacingMessage } from "shared/lib/userFacingError";
import { parseDraftId, parseDraftSave, parseJourneyId, parseNewDraft, parsePublishRequest } from "./draftInput";
import {
  createDraft,
  deleteDraft,
  duplicateCampaign,
  listMyDrafts,
  publishDraft,
  saveDraft,
  type DraftSummary,
  type PublishResult,
  type SaveResult,
} from "./drafts";
import { storedJourneyNodes } from "./storedNodes";

// The draft and lifecycle actions of journeys (JBD-FR-26, JBD-FR-27, CMP-FR-04 to CMP-FR-09). Each
// checks the session itself (CMP-NFR-02), acts as the signed-in user, and turns any failure that is
// not a refusal into a fixed message that names the action, as campaign management's failure
// handling says. Pause, resume, and delete leave the owner-or-admin check (CMP-FR-07) to the
// database helpers, which make it under the campaign's row lock.

type Failed = { error: string };

async function run<T>(action: string, work: (session: AdminSession) => Promise<T>): Promise<T | Failed> {
  try {
    const session = await assertSession();
    return await work(session);
  } catch (error) {
    console.error(`Failed to ${action}:`, error);
    return { error: userFacingMessage(error, `Failed to ${action}.`) };
  }
}

export async function listMyDraftsAction(): Promise<{ drafts: DraftSummary[] } | Failed> {
  return run("list your drafts", async ({ userId }) => ({ drafts: await listMyDrafts(userId) }));
}

export async function createDraftAction(input: unknown): Promise<{ id: string; version: number } | Failed> {
  return run("create the draft", ({ userId }) => createDraft(userId, parseNewDraft(input)));
}

export async function saveDraftAction(input: unknown): Promise<SaveResult | Failed> {
  return run("save the draft", ({ userId }) => saveDraft(userId, parseDraftSave(input)));
}

export async function deleteDraftAction(id: unknown): Promise<{ status: "deleted" } | Failed> {
  return run("delete the draft", async ({ userId }) => {
    await deleteDraft(userId, parseDraftId(id));
    return { status: "deleted" as const };
  });
}

export async function publishDraftAction(input: unknown): Promise<PublishResult | Failed> {
  return run("publish the journey", async ({ userId }) => {
    const result = await publishDraft(userId, parsePublishRequest(input));
    if (result.status === "published") revalidatePath("/v2/journeys");
    return result;
  });
}

const JOURNEYS = "/v2/journeys";

function changed(id: string): void {
  revalidatePath(JOURNEYS);
  revalidatePath(`${JOURNEYS}/${encodeURIComponent(id)}`);
}

export async function pauseJourneyAction(id: unknown): Promise<{ status: "paused" } | Failed> {
  return run("pause the journey", async (session) => {
    const campaignId = parseJourneyId(id);
    await updateCampaignStatus(campaignId, "paused", campaignActor(session), storedJourneyNodes);
    changed(campaignId);
    return { status: "paused" as const };
  });
}

export async function resumeJourneyAction(id: unknown): Promise<{ status: "active" } | Failed> {
  return run("resume the journey", async (session) => {
    const campaignId = parseJourneyId(id);
    await updateCampaignStatus(campaignId, "active", campaignActor(session), storedJourneyNodes);
    changed(campaignId);
    return { status: "active" as const };
  });
}

export async function deleteJourneyAction(id: unknown): Promise<{ status: "deleted" } | Failed> {
  return run("delete the journey", async (session) => {
    const campaignId = parseJourneyId(id);
    await deleteCampaign(campaignId, campaignActor(session));
    changed(campaignId);
    return { status: "deleted" as const };
  });
}

export async function duplicateJourneyAction(id: unknown): Promise<{ id: string; version: number } | { status: "missing" } | Failed> {
  return run("duplicate the journey", async ({ userId }) => {
    const draft = await duplicateCampaign(userId, parseJourneyId(id));
    if (draft === null) return { status: "missing" as const };
    revalidatePath(JOURNEYS);
    return draft;
  });
}

/** CMP-FR-19: what the delete dialog says before it asks. */
export async function peopleInJourneyAction(id: unknown): Promise<{ people: number } | Failed> {
  return run("count the people in the journey", async () => ({ people: await loadPeopleWaiting(parseJourneyId(id)) }));
}
