"use server";

import { revalidatePath } from "next/cache";
import { inTransaction } from "@/lib/db";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";
import { isUuid, passRetryQuery, runTransitionQuery, type RunAction } from "./imports";
import { assertDataImportAdmin, runOn } from "./server";

// DIM-FR-20, DIM-FR-25: only an admin approves or discards a held run, retries a failed run, or
// asks a stopped pass to run again. Each action checks the session and the role before it parses
// anything.

type Done = { done: true };
type Failed = { error: string };

const IMPORTS_PATH = "/v2/data/imports";

const REFUSED: Record<RunAction, string> = {
  approve: "This file is no longer held for review, or it can only be discarded.",
  discard: "This file is no longer held for review.",
  retry: "This file has not failed, or it was already retried.",
};

async function transition(action: RunAction, runId: unknown, failure: string): Promise<Done | Failed> {
  try {
    const admin = await assertDataImportAdmin();
    if (!isUuid(runId)) throw new UserFacingError("The file is missing.");
    const changed = await inTransaction(async (client) => runOn(client)(runTransitionQuery(action, runId, admin.userId)));
    if (changed.length === 0) throw new UserFacingError(REFUSED[action]);
    revalidatePath(IMPORTS_PATH);
    return { done: true };
  } catch (error) {
    console.error(`Failed to ${action} an import run:`, error);
    return { error: userFacingMessage(error, failure) };
  }
}

export async function approveRunAction(runId: unknown): Promise<Done | Failed> {
  return transition("approve", runId, "The file was not approved.");
}

export async function discardRunAction(runId: unknown): Promise<Done | Failed> {
  return transition("discard", runId, "The file was not discarded.");
}

export async function retryRunAction(runId: unknown): Promise<Done | Failed> {
  return transition("retry", runId, "The file was not retried.");
}

export async function retryPassAction(passId: unknown): Promise<Done | Failed> {
  try {
    await assertDataImportAdmin();
    if (!isUuid(passId)) throw new UserFacingError("The pass is missing.");
    const changed = await inTransaction(async (client) => runOn(client)(passRetryQuery(passId)));
    if (changed.length === 0) throw new UserFacingError("This pass has not stopped, or a retry was already asked for.");
    revalidatePath(IMPORTS_PATH);
    return { done: true };
  } catch (error) {
    console.error("Failed to retry an import metric pass:", error);
    return { error: userFacingMessage(error, "The pass was not retried.") };
  }
}
