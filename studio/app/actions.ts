"use server";

import { revalidatePath } from "next/cache";
import * as db from "@/lib/db";
import { assertAdmin, assertSession } from "@/shared/auth/session";
import { parseEventKind } from "shared/lib/eventCatalog";
import { parseSegmentId, parseSegmentInput } from "shared/lib/segments";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";
import { parseCampaignForPublish, parseJourney } from "@/entities/journey/model/parseCampaign";
import { flattenCampaignTree } from "@/entities/journey/model/utils";
import { generateSourceKey, parseAppId } from "../src/features/data-ingestion/model/sourceKeys";
import type { UserEventPageCursor } from "./types";

// Server Action: Get Campaign Node Stats. A failure is not zero users, so it returns an error and
// the builder keeps the counts it has.
export async function getCampaignNodeStatsAction(
  campaignId: string,
): Promise<{ stats: Record<string, number> } | { error: string }> {
  try {
    const session = await assertSession();
    return { stats: await db.getCampaignNodeStats(campaignId, db.campaignActor(session)) };
  } catch (error) {
    console.error("Failed to get campaign node stats:", error);
    return { error: "Node counts could not load." };
  }
}

// Resume rebuilds the node rows from the journey stored by an earlier publish. A manual edit or
// an older studio may have stored a malformed one, so it is parsed like a submitted journey.
function storedJourneyNodes(campaignId: string, storedRoot: unknown): db.DbCampaignNode[] {
  let journey;
  try {
    journey = parseJourney(storedRoot);
  } catch (error) {
    if (!(error instanceof UserFacingError)) throw error;
    throw new UserFacingError(`Campaign ${campaignId} cannot resume. ${error.message}`);
  }
  return flattenCampaignTree(campaignId, journey);
}

// Server Action: Publish Campaign. The node rows are built here from the journey, not taken
// from the browser.
export async function publishCampaignAction(input: unknown) {
  try {
    const session = await assertSession();
    const campaign = parseCampaignForPublish(input);
    await db.publishCampaign(campaign, session.userId, flattenCampaignTree);
    revalidatePath("/campaign");
    return { success: true };
  } catch (error) {
    console.error("Failed to publish campaign:", error);
    return { error: userFacingMessage(error, "Failed to publish campaign.") };
  }
}

// Server Action: Delete Campaign
export async function deleteCampaignAction(campaignId: string) {
  try {
    const session = await assertSession();
    await db.deleteCampaign(campaignId, db.campaignActor(session));
    revalidatePath("/campaign");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete campaign:", error);
    return { error: userFacingMessage(error, "Failed to delete campaign.") };
  }
}

// Server Action: Toggle/Update Campaign Status. Resume rebuilds the node rows from the stored
// journey.
export async function toggleCampaignStatusAction(campaignId: string, status: "active" | "paused") {
  try {
    const session = await assertSession();
    if (status !== "active" && status !== "paused") return { error: "Status must be active or paused." };
    await db.updateCampaignStatus(campaignId, status, db.campaignActor(session), storedJourneyNodes);
    revalidatePath("/campaign");
    return { success: true };
  } catch (error) {
    console.error("Failed to update campaign status:", error);
    return { error: userFacingMessage(error, "Failed to update campaign status.") };
  }
}

// Server Action: Save a segment. Every staff user may manage segments. An edit that active
// campaigns use returns those campaigns until the editor confirms each one (SEG-FR-07).
export async function saveSegmentAction(input: unknown, confirmedCampaignIds: unknown = []) {
  try {
    const session = await assertSession();
    const confirmed = Array.isArray(confirmedCampaignIds)
      ? confirmedCampaignIds.filter((id): id is string => typeof id === "string")
      : [];
    const result = await db.saveSegment(parseSegmentInput(input), session.userId, confirmed);
    if (!result.saved) return { confirm: result.confirm };
    revalidatePath("/segments");
    return { success: true as const, id: result.id };
  } catch (error) {
    console.error("Failed to save segment:", error);
    return { error: userFacingMessage(error, "Failed to save the segment.") };
  }
}

// Server Action: Delete a segment. Refused while an active or paused campaign uses it.
export async function deleteSegmentAction(segmentId: unknown) {
  try {
    await assertSession();
    await db.deleteSegment(parseSegmentId(segmentId));
    revalidatePath("/segments");
    return { success: true as const };
  } catch (error) {
    console.error("Failed to delete segment:", error);
    return { error: userFacingMessage(error, "Failed to delete the segment.") };
  }
}

// Server Action: Get User Events
export async function getUserEventsAction() {
  try {
    await assertSession();
    return await db.getUserEvents();
  } catch (error) {
    console.error("Failed to get user events:", error);
    return [];
  }
}

export async function getUserEventSummariesPageAction(
  cursor: UserEventPageCursor | null,
) {
  try {
    await assertAdmin();
    return {
      page: await db.getUserEventSummariesPage(cursor),
    };
  } catch (error) {
    console.error("Failed to get user event summaries:", error);
    return { error: "Failed to load more events." };
  }
}

export async function getUserEventFieldsAction(userEventId: string) {
  try {
    await assertAdmin();
    return {
      fields: await db.getUserEventFields(userEventId),
    };
  } catch (error) {
    console.error("Failed to get user event fields:", error);
    return { error: "Failed to load event attributes." };
  }
}

// Server Action: Create User Event
export async function createUserEventAction(eventName: string, displayName: string, description?: string) {
  try {
    await assertAdmin();
    await db.createUserEvent(eventName, displayName, description);
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to create user event:", error);
    return { error: userFacingMessage(error, "Failed to create user event.") };
  }
}


// Server Action: Create User Event with Fields in Bulk
export async function createUserEventWithFieldsAction(
  name: string, 
  displayName: string, 
  description: string | undefined,
  kind: unknown,
  fields: { fieldPath: string; displayName: string; dataType: string; exampleValue?: string }[]
) {
  try {
    await assertAdmin();
    const eventKind = parseEventKind(kind);
    const dbFields = fields.map(f => ({
      field_path: f.fieldPath,
      display_name: f.displayName,
      data_type: f.dataType,
      example_value: f.exampleValue
    }));
    const eventId = await db.createUserEventWithFields(name, displayName, description, eventKind, dbFields);
    revalidatePath("/admin");
    return { success: true, eventId };
  } catch (error) {
    console.error("Failed to create user event with fields:", error);
    return { error: userFacingMessage(error, "Failed to create user event with fields.") };
  }
}

// Server Action: Change an event's display name, description, and kind (Admin only)
export async function updateUserEventAction(eventId: string, displayName: string, description: string, kind: unknown) {
  try {
    await assertAdmin();
    await db.updateUserEvent(eventId, displayName, description, parseEventKind(kind));
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to update user event:", error);
    return { error: userFacingMessage(error, "Failed to update the event.") };
  }
}

// Server Action: List what deleting a user event also deletes
export async function getUserEventUsageAction(eventId: string) {
  try {
    await assertAdmin();
    return { usage: await db.getUserEventUsage(eventId) };
  } catch (error) {
    console.error("Failed to get user event usage:", error);
    return { error: userFacingMessage(error, "Failed to load what uses this event.") };
  }
}

// Server Action: Delete User Event
export async function deleteUserEventAction(eventId: string) {
  try {
    await assertAdmin();
    await db.deleteUserEvent(eventId);
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete user event:", error);
    return { error: userFacingMessage(error, "Failed to delete user event.") };
  }
}

// Server Action: Create User Event Field
export async function createUserEventFieldAction(
  userEventId: string,
  fieldPath: string,
  displayName: string,
  dataType: string,
  exampleValue?: string,
) {
  try {
    await assertAdmin();
    await db.createUserEventField(
      userEventId,
      fieldPath,
      displayName,
      dataType,
      exampleValue,
    );
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to create user event field:", error);
    return { error: userFacingMessage(error, "Failed to create user event field.") };
  }
}

// Server Action: Delete User Event Field
export async function deleteUserEventFieldAction(fieldPath: string, userEventId: string) {
  try {
    await assertAdmin();
    await db.deleteUserEventField(fieldPath, userEventId);
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to delete user event field:", error);
    return { error: userFacingMessage(error, "Failed to delete user event field.") };
  }
}

export async function updateUserEventFieldAction(
  userEventId: string,
  originalFieldPath: string,
  changes: { fieldPath: string; displayName: string; dataType: string; exampleValue: string; defaultValue: string },
) {
  try {
    await assertAdmin();
    await db.updateUserEventField(
      userEventId,
      originalFieldPath,
      changes.fieldPath,
      changes.displayName,
      changes.dataType,
      changes.exampleValue,
      changes.defaultValue,
    );
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to update user event field:", error);
    return { error: userFacingMessage(error, "Failed to update user event field.") };
  }
}

// Server Action: Turn an event's schema gate on or off (Admin only)
export async function setUserEventSchemaEnforcementAction(eventId: string, enforce: boolean) {
  try {
    await assertAdmin();
    if (typeof enforce !== "boolean") return { error: "The schema gate must be on or off." };
    await db.setUserEventSchemaEnforcement(eventId, enforce);
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to change the schema gate:", error);
    return { error: userFacingMessage(error, "Failed to change the schema gate.") };
  }
}

// Server Action: Switch an event between active and inactive (Admin only)
export async function setUserEventStatusAction(eventId: string, status: string) {
  try {
    await assertAdmin();
    await db.setUserEventStatus(eventId, status);
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to change the event status:", error);
    return { error: userFacingMessage(error, "Failed to change the event status.") };
  }
}

// Server Action: Mark an event attribute required or optional (Admin only)
export async function setUserEventFieldRequiredAction(userEventId: string, fieldPath: string, required: boolean) {
  try {
    await assertAdmin();
    if (typeof required !== "boolean") return { error: "Required must be true or false." };
    await db.setUserEventFieldRequired(userEventId, fieldPath, required);
    revalidatePath("/admin");
    return { success: true };
  } catch (error) {
    console.error("Failed to change whether the attribute is required:", error);
    return { error: userFacingMessage(error, "Failed to change whether the attribute is required.") };
  }
}

// Server Action: Create a data ingestion source key. The key is returned once and only its hash
// is stored (DIA-NFR-05).
export async function createSourceKeyAction(appId: string): Promise<{ key: string } | { error: string }> {
  try {
    const session = await assertAdmin();
    const parsedAppId = parseAppId(appId);
    const { key, hash, hint } = generateSourceKey();
    await db.createSourceKey(parsedAppId, hash, hint, session.userId);
    revalidatePath("/admin/source-keys");
    return { key };
  } catch (error) {
    console.error("Failed to create a source key:", error);
    return { error: userFacingMessage(error, "Failed to create the source key.") };
  }
}

// Server Action: Revoke a data ingestion source key.
export async function revokeSourceKeyAction(id: string): Promise<{ success: true } | { error: string }> {
  try {
    await assertAdmin();
    await db.revokeSourceKey(id);
    revalidatePath("/admin/source-keys");
    return { success: true };
  } catch (error) {
    console.error("Failed to revoke a source key:", error);
    return { error: userFacingMessage(error, "Failed to revoke the source key.") };
  }
}
