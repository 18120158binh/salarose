"use server";

import { revalidatePath } from "next/cache";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";
import { parseCustomerKey, shortCode } from "./privacyLog";
import { assertDataImportAdmin, requestPersonDeletion } from "./server";

// DIM-FR-23, DIM-FR-25: only an admin asks to delete a person. The reply never holds the key.

const PRIVACY_PATH = "/v2/data/privacy";

export type DeletionReply = { status: "requested"; code: string } | { status: "not_configured" } | { error: string };

export async function requestPersonDeletionAction(customerKey: unknown): Promise<DeletionReply> {
  try {
    const admin = await assertDataImportAdmin();
    const key = parseCustomerKey(customerKey);
    if (key === null) throw new UserFacingError("Enter the customer key.");
    const result = await requestPersonDeletion(admin, key, PRIVACY_PATH);
    if (result.status === "not_configured") return result;
    revalidatePath(PRIVACY_PATH);
    return { status: "requested", code: shortCode(result.tombstone) };
  } catch (error) {
    console.error("Failed to request a person's deletion:", error);
    return { error: userFacingMessage(error, "The deletion was not requested.") };
  }
}
