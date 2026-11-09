"use server";

import { revalidatePath } from "next/cache";
import * as db from "@/lib/db";
import { assertAdmin } from "@/shared/auth/session";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";
import { generateSourceKey, parseAppId } from "./sourceKeys";

// DIA-FR-16, DIA-FR-17, DHL-FR-04: only an admin creates or revokes a source key. Each action checks
// the session and the role itself before it parses or writes anything.

type Failed = { error: string };

/** The key comes back once, in this reply. Only its hash and hint are stored. */
export async function createSourceKeyAction(appId: unknown): Promise<{ appId: string; key: string } | Failed> {
  try {
    const session = await assertAdmin();
    const parsedAppId = parseAppId(appId);
    const { key, hash, hint } = generateSourceKey();
    await db.createSourceKey(parsedAppId, hash, hint, session.userId);
    revalidatePath("/v2/data/sources");
    return { appId: parsedAppId, key };
  } catch (error) {
    console.error("Failed to create a source key:", error);
    return { error: userFacingMessage(error, "Failed to create the source key.") };
  }
}

export async function revokeSourceKeyAction(id: unknown): Promise<{ done: true } | Failed> {
  try {
    await assertAdmin();
    if (typeof id !== "string" || id === "") throw new UserFacingError("The source key is missing.");
    await db.revokeSourceKey(id);
    revalidatePath("/v2/data/sources");
    return { done: true };
  } catch (error) {
    console.error("Failed to revoke a source key:", error);
    return { error: userFacingMessage(error, "Failed to revoke the source key.") };
  }
}
