import type { SqlQuery } from "@/lib/db";

export interface MetricCreator {
  metricId: string;
  // The creator's email. Null for a metric created before studio kept its creator, or whose
  // creator's user was deleted. Show it as "Unknown".
  createdBy: string | null;
  createdAt: string | null;
}

export function metricCreatorsQuery(metricIds: readonly string[]): SqlQuery {
  return {
    text: `SELECT d.id, d.created_at, u.email AS created_by FROM user_metric_definitions d
LEFT JOIN system_users u ON u.id = d.created_by WHERE d.id = ANY($1::text[])`,
    values: [metricIds],
  };
}

function isoTime(value: unknown): string | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseMetricCreators(rows: Record<string, unknown>[]): MetricCreator[] {
  return rows.flatMap((row) => typeof row.id === "string"
    ? [{
      metricId: row.id,
      createdBy: typeof row.created_by === "string" ? row.created_by : null,
      createdAt: isoTime(row.created_at),
    }]
    : []);
}
