import "server-only";
import { readOnly } from "@/lib/db";
import { instant, LATEST_DONE_PASS_QUERY } from "./imports";
import {
  compareMetrics,
  DATASET_METRICS_QUERY,
  datasetMetricState,
  EVENT_METRIC_USES_QUERY,
  EVENT_METRICS_QUERY,
  METRIC_DATASETS_QUERY,
  parseDatasetMetric,
  parseEventMetrics,
  parseMetricDataset,
  usesOf,
  type MetricDataset,
  type MetricRow,
} from "./metrics";
import { findFieldUses, importedField } from "./uses";

const READ_TIMEOUT_MS = 8_000;

export interface MetricsPage {
  metrics: MetricRow[];
  datasets: MetricDataset[];
  /** The as_of of the newest done pass, or null when none has finished. */
  latestDoneAsOf: number | null;
}

/** CMP-FR-22, CMP-FR-23: every metric of both kinds, live first, with its uses. The caller checked the session. */
export async function loadMetricsPage(): Promise<MetricsPage> {
  const now = Date.now();
  return readOnly(READ_TIMEOUT_MS, async (run) => {
    const events = parseEventMetrics(await run(EVENT_METRICS_QUERY), await run(EVENT_METRIC_USES_QUERY));
    const latestDoneAsOf = instant((await run(LATEST_DONE_PASS_QUERY))[0]?.as_of);
    const datasetRows = (await run(DATASET_METRICS_QUERY)).flatMap((row) => parseDatasetMetric(row) ?? []);
    const datasetMetrics: MetricRow[] = [];
    for (const metric of datasetRows) {
      const uses = usesOf(await findFieldUses(run, importedField(metric.dataset.name, metric.name)));
      datasetMetrics.push({ ...metric, uses, state: datasetMetricState(metric.archivedAt, latestDoneAsOf, now) });
    }
    const datasets = (await run(METRIC_DATASETS_QUERY)).flatMap((row) => parseMetricDataset(row) ?? []);
    return { metrics: [...events, ...datasetMetrics].sort(compareMetrics), datasets, latestDoneAsOf };
  });
}
