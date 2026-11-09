import "server-only";
import { readOnly, type RunQuery } from "@/lib/db";
import { assertSession } from "@/shared/auth/session";
import {
  loadDatasetBase,
  loadDatasetOverview,
  loadDatasetWriters,
  type ColumnUses,
  type DatasetDetail,
  type DatasetOverview,
} from "./datasets";
import { findFieldUses, findMetricsUsingColumn, importedField } from "./uses";

const READ_TIMEOUT_MS = 10_000;

/** What uses each column: the metrics on it, and the campaigns and segments that name its field. */
export async function columnUses(run: RunQuery, id: string, dataset: string, columns: string[]): Promise<Record<string, ColumnUses>> {
  const entries = await Promise.all(
    columns.map(async (column): Promise<[string, ColumnUses]> => {
      const [metrics, fields] = await Promise.all([
        findMetricsUsingColumn(run, id, column),
        findFieldUses(run, importedField(dataset, column)),
      ]);
      return [column, { metrics, ...fields }];
    }),
  );
  return Object.fromEntries(entries);
}

// DIM-FR-01, DIM-FR-25: every staff user reads datasets. Each loader checks the session itself.
export async function loadDatasets(): Promise<DatasetOverview> {
  await assertSession();
  return readOnly(READ_TIMEOUT_MS, loadDatasetOverview);
}

export async function loadDataset(id: string): Promise<DatasetDetail | null> {
  await assertSession();
  return readOnly(READ_TIMEOUT_MS, async (run) => {
    const base = await loadDatasetBase(run, id);
    if (base === null) return null;
    const columns = base.versions[0].value.columns.map((column) => column.name);
    const [writers, uses] = await Promise.all([loadDatasetWriters(run, id), columnUses(run, id, base.name, columns)]);
    return { ...base, writers, uses };
  });
}
