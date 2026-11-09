"use server";

import { revalidatePath } from "next/cache";
import { inTransaction, type RunQuery } from "@/lib/db";
import { assertSession } from "@/shared/auth/session";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";
import { isUuid } from "./imports";
import {
  insertMetricQuery,
  METRIC_DATASETS_QUERY,
  parseMetricDataset,
  parseMetricInput,
  recordTypeIdOf,
  updateMetricQuery,
  usedRefusal,
  usesOf,
  type MetricDataset,
  type MetricInput,
} from "./metrics";
import { runOn } from "./server";
import { findFieldUses, importedField } from "./uses";

// DIM-FR-17, DIM-FR-18, DIM-FR-25: every staff user may create, edit, archive, and unarchive a
// dataset metric. No action deletes one. Each action checks the session before it parses anything.

type Failed = { error: string; problems?: string[] };

const METRICS_PATH = "/v2/data/metrics";
const UNIQUE_VIOLATION = "23505";

class InputError extends UserFacingError {
  constructor(readonly problems: string[]) {
    super("The metric was not saved. Fix the fields below.");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

async function datasetFor(run: RunQuery, recordTypeId: string): Promise<MetricDataset> {
  const row = (await run(METRIC_DATASETS_QUERY)).find((candidate) => candidate.id === recordTypeId);
  const dataset = row === undefined ? null : parseMetricDataset(row);
  if (!dataset) throw new UserFacingError("Pick a dataset of records. A customer dataset has no metrics.");
  return dataset;
}

function parsed(input: unknown, dataset: MetricDataset): MetricInput {
  const result = parseMetricInput(input, dataset);
  if (!result.ok) throw new InputError(result.problems);
  return result.value;
}

function failed(error: unknown, fallback: string): Failed {
  if (error instanceof InputError) return { error: error.message, problems: error.problems };
  return { error: userFacingMessage(error, fallback) };
}

function duplicateName(name: string): UserFacingError {
  return new UserFacingError(`This dataset already has a metric named ${name}.`);
}

export async function createDatasetMetricAction(input: unknown): Promise<{ id: string } | Failed> {
  try {
    const session = await assertSession();
    const recordTypeId = recordTypeIdOf(input);
    if (recordTypeId === null) throw new UserFacingError("Pick a dataset.");
    const id = await inTransaction(async (client) => {
      const run = runOn(client);
      const metric = parsed(input, await datasetFor(run, recordTypeId));
      const rows = await run(insertMetricQuery(metric, session.userId));
      if (rows.length === 0) throw duplicateName(metric.name);
      return String(rows[0].id);
    });
    revalidatePath(METRICS_PATH);
    return { id };
  } catch (error) {
    console.error("Failed to create a dataset metric:", error);
    return failed(error, "The metric was not saved.");
  }
}

/**
 * Edits a metric that is not archived. Its dataset stays. A rename is refused while anything
 * names the metric's imported field (DIM-FR-18).
 */
export async function updateDatasetMetricAction(id: unknown, input: unknown): Promise<{ done: true } | Failed> {
  try {
    await assertSession();
    if (!isUuid(id)) throw new UserFacingError("The metric is missing.");
    await inTransaction(async (client) => {
      const run = runOn(client);
      const current = await lockMetric(run, id);
      if (current.archived) throw new UserFacingError("An archived metric is frozen. Unarchive it to edit it.");
      const fields = typeof input === "object" && input !== null ? input : {};
      const metric = parsed({ ...fields, recordTypeId: current.recordTypeId }, await datasetFor(run, current.recordTypeId));
      if (metric.name !== current.name) {
        const uses = usesOf(await findFieldUses(run, importedField(current.dataset, current.name)));
        if (uses.length > 0) throw new UserFacingError(usedRefusal("renamed", uses));
      }
      try {
        await run(updateMetricQuery(id, metric));
      } catch (error) {
        if (isUniqueViolation(error)) throw duplicateName(metric.name);
        throw error;
      }
    });
    revalidatePath(METRICS_PATH);
    return { done: true };
  } catch (error) {
    console.error("Failed to edit a dataset metric:", error);
    return failed(error, "The metric was not saved.");
  }
}

/** DIM-FR-18: archive is refused while an active or paused campaign or a segment names the metric. */
export async function archiveDatasetMetricAction(id: unknown): Promise<{ done: true } | Failed> {
  try {
    await assertSession();
    if (!isUuid(id)) throw new UserFacingError("The metric is missing.");
    await inTransaction(async (client) => {
      const run = runOn(client);
      const current = await lockMetric(run, id);
      if (current.archived) return;
      const uses = usesOf(await findFieldUses(run, importedField(current.dataset, current.name)));
      if (uses.length > 0) throw new UserFacingError(usedRefusal("archived", uses));
      await run({ text: `UPDATE import_metric_definitions SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, values: [id] });
    });
    revalidatePath(METRICS_PATH);
    return { done: true };
  } catch (error) {
    console.error("Failed to archive a dataset metric:", error);
    return failed(error, "The metric was not archived.");
  }
}

export async function unarchiveDatasetMetricAction(id: unknown): Promise<{ done: true } | Failed> {
  try {
    await assertSession();
    if (!isUuid(id)) throw new UserFacingError("The metric is missing.");
    await inTransaction(async (client) => {
      const run = runOn(client);
      await lockMetric(run, id);
      await run({ text: `UPDATE import_metric_definitions SET archived_at = NULL WHERE id = $1`, values: [id] });
    });
    revalidatePath(METRICS_PATH);
    return { done: true };
  } catch (error) {
    console.error("Failed to unarchive a dataset metric:", error);
    return failed(error, "The metric was not unarchived.");
  }
}

async function lockMetric(
  run: RunQuery,
  id: string,
): Promise<{ recordTypeId: string; dataset: string; name: string; archived: boolean }> {
  const [row] = await run({
    text: `SELECT m.record_type_id, t.name AS dataset, m.name, m.archived_at IS NOT NULL AS archived
           FROM import_metric_definitions m JOIN import_record_types t ON t.id = m.record_type_id
           WHERE m.id = $1 FOR UPDATE OF m`,
    values: [id],
  });
  if (!row) throw new UserFacingError("This metric no longer exists.");
  return { recordTypeId: String(row.record_type_id), dataset: String(row.dataset), name: String(row.name), archived: row.archived === true };
}
