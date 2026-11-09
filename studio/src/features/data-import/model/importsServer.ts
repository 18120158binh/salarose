import "server-only";
import { readOnly } from "@/lib/db";
import {
  DATASET_OPTIONS_QUERY,
  LATEST_DONE_PASS_QUERY,
  parseFilterCounts,
  parsePass,
  parseRun,
  PASSES_QUERY,
  runCountsQuery,
  runsQuery,
  stalenessOf,
  type ImportRun,
  type MetricPass,
  type RunFilter,
  type RunQuery,
  type Staleness,
} from "./imports";

const READ_TIMEOUT_MS = 5_000;

export interface ImportsPage {
  runs: ImportRun[];
  counts: Record<RunFilter, number>;
  datasets: { id: string; displayName: string }[];
  passes: MetricPass[];
  staleness: Staleness;
}

/** DIM-FR-20: one read-only snapshot for the runs, the filter counts, and the passes. The caller checked the session. */
export async function loadImportsPage(query: RunQuery): Promise<ImportsPage> {
  return readOnly(READ_TIMEOUT_MS, async (run) => {
    const [runRows, countRows, datasetRows, passRows, doneRows] = [
      await run(runsQuery(query)),
      await run(runCountsQuery(query.dataset)),
      await run(DATASET_OPTIONS_QUERY),
      await run(PASSES_QUERY),
      await run(LATEST_DONE_PASS_QUERY),
    ];
    const passes = passRows.flatMap((row) => parsePass(row) ?? []);
    return {
      runs: runRows.flatMap((row) => parseRun(row) ?? []),
      counts: parseFilterCounts(countRows[0]),
      datasets: datasetRows.flatMap((row) =>
        typeof row.id === "string" && typeof row.display_name === "string" ? [{ id: row.id, displayName: row.display_name }] : [],
      ),
      passes,
      staleness: stalenessOf(passes, doneRows[0] === undefined ? null : parsePass(doneRows[0]), Date.now()),
    };
  });
}
