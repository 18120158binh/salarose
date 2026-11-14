"use server";

import { revalidatePath } from "next/cache";
import { inTransaction } from "@/lib/db";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";
import { isDatasetId } from "./datasets";
import { assertDataImportAdmin, runOn } from "./server";

// DIM-FR-08, DIM-FR-09, DIM-FR-25, DIA-FR-40: only an admin grants a source key a dataset, and a
// snapshot dataset has one writer. Each action checks the session and the role before it reads.

type Failed = { error: string };

const SOURCES_PATH = "/v2/data/sources";

function sourceKeyIdOf(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new UserFacingError("The source key is missing.");
  return value;
}

function datasetIdOf(value: unknown): string {
  if (!isDatasetId(value)) throw new UserFacingError("The dataset is missing.");
  return value;
}

export async function grantImportScopeAction(sourceKeyId: unknown, datasetId: unknown): Promise<{ done: true } | Failed> {
  try {
    await assertDataImportAdmin();
    const keyId = sourceKeyIdOf(sourceKeyId);
    const typeId = datasetIdOf(datasetId);
    await inTransaction(async (client) => {
      const run = runOn(client);
      // The row lock serializes grants of one dataset, so two admins cannot each add a writer.
      const [dataset] = await run({
        text: `SELECT t.name, v.delivery_mode FROM import_record_types t
                 JOIN import_record_type_versions v ON v.record_type_id = t.id AND v.version = t.current_version
                WHERE t.id = $1 FOR UPDATE OF t`,
        values: [typeId],
      });
      if (!dataset) throw new UserFacingError("The dataset no longer exists.");
      const [key] = await run({
        text: `SELECT revoked_at FROM ingestion_source_keys WHERE id = $1`,
        values: [keyId],
      });
      if (!key) throw new UserFacingError("The source key no longer exists.");
      if (key.revoked_at !== null) throw new UserFacingError("The source key is revoked.");
      if (dataset.delivery_mode === "snapshot") {
        const [writer] = await run({
          text: `SELECT k.app_id FROM import_source_scopes s JOIN ingestion_source_keys k ON k.id = s.source_key_id
                  WHERE s.record_type_id = $1 AND s.source_key_id <> $2 AND k.revoked_at IS NULL
                  ORDER BY k.app_id LIMIT 1`,
          values: [typeId, keyId],
        });
        if (writer) {
          throw new UserFacingError(
            `"${String(dataset.name)}" is a snapshot dataset, and ${String(writer.app_id)} already writes it. Remove that key's access first.`,
          );
        }
      }
      await run({
        text: `INSERT INTO import_source_scopes (source_key_id, record_type_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        values: [keyId, typeId],
      });
    });
    revalidatePath(SOURCES_PATH);
    return { done: true };
  } catch (error) {
    console.error("Failed to grant a dataset to a source key:", error);
    return { error: userFacingMessage(error, "Failed to grant the dataset.") };
  }
}

export async function revokeImportScopeAction(sourceKeyId: unknown, datasetId: unknown): Promise<{ done: true } | Failed> {
  try {
    await assertDataImportAdmin();
    const keyId = sourceKeyIdOf(sourceKeyId);
    const typeId = datasetIdOf(datasetId);
    await inTransaction(async (client) => {
      await runOn(client)({
        text: `DELETE FROM import_source_scopes WHERE source_key_id = $1 AND record_type_id = $2`,
        values: [keyId, typeId],
      });
    });
    revalidatePath(SOURCES_PATH);
    return { done: true };
  } catch (error) {
    console.error("Failed to remove a dataset from a source key:", error);
    return { error: userFacingMessage(error, "Failed to remove the dataset.") };
  }
}
