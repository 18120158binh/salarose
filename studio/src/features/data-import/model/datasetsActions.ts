"use server";

import { revalidatePath } from "next/cache";
import { inTransaction, type RunQuery } from "@/lib/db";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";
import { usesOf, versionOf, VERSIONS_QUERY, type Refusal } from "./datasets";
import { columnUses } from "./datasetsServer";
import { assertDataImportAdmin, runOn } from "./server";
import { isDatasetKind, isSystemName, parseDatasetVersion, SYSTEM_NAME_RULE, versionChange } from "./version";

// DIM-FR-01 to DIM-FR-07, DIM-FR-25: only an admin creates a dataset or saves a version. Each
// action checks the session and the role before it parses or reads anything.

export type DatasetSaved = { saved: true; id: string; version: number };
export type DatasetRefused = { error: string; refusals?: Refusal[] };

const LIST_PATH = "/v2/data/datasets";

function displayNameOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new UserFacingError("Give the dataset a display name.");
  return value.trim();
}

function parsedVersion(kind: Parameters<typeof parseDatasetVersion>[0], input: unknown) {
  const parsed = parseDatasetVersion(kind, input);
  if (!parsed.ok) throw new UserFacingError(parsed.problems.join("\n"));
  return parsed.value;
}

function insertVersion(run: RunQuery, id: string, version: number, value: ReturnType<typeof parsedVersion>, userId: string) {
  return run({
    text: `INSERT INTO import_record_type_versions (record_type_id, version, columns, roles, delivery_mode, time_zone, delimiter, created_by)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8)`,
    values: [id, version, JSON.stringify(value.columns), JSON.stringify(value.roles), value.deliveryMode, value.timeZone, value.delimiter, userId],
  });
}

export async function createDatasetAction(input: {
  name: unknown;
  displayName: unknown;
  kind: unknown;
  version: unknown;
}): Promise<DatasetSaved | DatasetRefused> {
  try {
    const admin = await assertDataImportAdmin();
    if (!isSystemName(input.name)) throw new UserFacingError(`System name: ${SYSTEM_NAME_RULE}`);
    if (!isDatasetKind(input.kind)) throw new UserFacingError("Pick what each row is: a customer or a record.");
    const name = input.name;
    const kind = input.kind;
    const displayName = displayNameOf(input.displayName);
    const value = parsedVersion(kind, input.version);
    const id = await inTransaction(async (client) => {
      const run = runOn(client);
      const [created] = await run({
        text: `INSERT INTO import_record_types (name, display_name, kind, current_version, created_by)
               VALUES ($1, $2, $3, 1, $4) ON CONFLICT (name) DO NOTHING RETURNING id`,
        values: [name, displayName, kind, admin.userId],
      });
      if (!created) throw new UserFacingError(`A dataset named "${name}" already exists.`);
      await insertVersion(run, String(created.id), 1, value, admin.userId);
      return String(created.id);
    });
    revalidatePath(LIST_PATH);
    return { saved: true, id, version: 1 };
  } catch (error) {
    console.error("Failed to create a dataset:", error);
    return { error: userFacingMessage(error, "Failed to create the dataset.") };
  }
}

function refusalMessage(refusals: Refusal[]): string {
  const columns = refusals.map((refusal) => refusal.column).join(", ");
  return `Can't rename, retype or delete ${columns} while something uses it. Change or delete those uses first. Nothing was saved.`;
}

/**
 * Saves the editor's draft over the current version. Adding a column, an alias, a role, mode, time
 * zone or separator change makes a new version (DIM-FR-04). Only display names and PII flags change
 * the current version in place, as the contract's Versions table allows (DIM-FR-07). The use check
 * and the write run in one transaction, under a lock on the dataset row (DIM-FR-05).
 */
export async function saveDatasetVersionAction(input: {
  id: unknown;
  baseVersion: unknown;
  displayName: unknown;
  version: unknown;
}): Promise<DatasetSaved | DatasetRefused> {
  try {
    const admin = await assertDataImportAdmin();
    if (typeof input.id !== "string" || input.id === "") throw new UserFacingError("The dataset is missing.");
    const id = input.id;
    const displayName = displayNameOf(input.displayName);
    const result = await inTransaction(async (client): Promise<DatasetSaved | DatasetRefused> => {
      const run = runOn(client);
      const [row] = await run({
        text: `SELECT name, kind, current_version FROM import_record_types WHERE id = $1 FOR UPDATE`,
        values: [id],
      });
      if (!row || !isDatasetKind(row.kind)) throw new UserFacingError("This dataset no longer exists.");
      const kind = row.kind;
      const currentVersion = Number(row.current_version);
      if (input.baseVersion !== currentVersion) {
        throw new UserFacingError(`Someone saved version ${currentVersion} since you opened this page. Reload to see it.`);
      }
      const [stored] = (await run({ text: VERSIONS_QUERY, values: [id] })).map((version) => versionOf(kind, version));
      if (!stored || stored.version !== currentVersion) throw new Error(`Dataset ${id} version ${currentVersion} could not be read.`);
      const next = parsedVersion(kind, input.version);
      const change = versionChange(stored.value, next);

      if (change.breakingColumns.length > 0) {
        const uses = await columnUses(run, id, String(row.name), change.breakingColumns);
        const refusals = change.breakingColumns
          .map((column) => ({ column, uses: usesOf(uses[column]) }))
          .filter((refusal) => refusal.uses.length > 0);
        if (refusals.length > 0) return { error: refusalMessage(refusals), refusals };
      }
      if (change.rederives) {
        const busy = await run({
          text: `SELECT 1 FROM import_runs WHERE record_type_id = $1 AND state IN ('validating', 'applying') LIMIT 1`,
          values: [id],
        });
        if (busy.length > 0) {
          throw new UserFacingError("A file for this dataset is being checked or applied. Save again when it is done.");
        }
      }

      if (change.newVersion) {
        await insertVersion(run, id, currentVersion + 1, next, admin.userId);
        await run({
          text: `UPDATE import_record_types SET current_version = $2, display_name = $3 WHERE id = $1`,
          values: [id, currentVersion + 1, displayName],
        });
        return { saved: true, id, version: currentVersion + 1 };
      }
      await run({
        text: `UPDATE import_record_type_versions SET columns = $3::jsonb WHERE record_type_id = $1 AND version = $2`,
        values: [id, currentVersion, JSON.stringify(next.columns)],
      });
      await run({ text: `UPDATE import_record_types SET display_name = $2 WHERE id = $1`, values: [id, displayName] });
      return { saved: true, id, version: currentVersion };
    });
    if ("saved" in result) {
      revalidatePath(LIST_PATH);
      revalidatePath(`${LIST_PATH}/${id}`);
    }
    return result;
  } catch (error) {
    console.error("Failed to save a dataset version:", error);
    return { error: userFacingMessage(error, "Failed to save the dataset.") };
  }
}
