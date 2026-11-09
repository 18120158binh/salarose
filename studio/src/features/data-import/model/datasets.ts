import type { RunQuery } from "@/lib/db";
import {
  isOneOf,
  LIST_ROLES,
  ROLE_LABELS,
  RUN_SOURCES,
  RUN_STATES,
  SINGLE_ROLES,
  type ColumnType,
  type DatasetKind,
  type DatasetRoles,
  type DatasetVersion,
  type DeliveryMode,
  type Role,
  type RunSource,
  type RunState,
} from "./domain";
import { isDatasetKind, parseDatasetVersion, type VersionChange } from "./version";

// The Datasets list and the dataset editor (DIM-FR-01 to DIM-FR-07, DIM-FR-24). Rows from
// Postgres are parsed here once; the pages trust these types.

export const KIND_LABELS: Record<DatasetKind, string> = {
  profile: "One row per customer",
  event: "One row per record",
};

export const KIND_FILTER_LABELS: Record<DatasetKind, string> = {
  profile: "Customer profiles",
  event: "Events",
};

export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  incremental: "New and changed rows",
  snapshot: "Full snapshot",
};

export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  string: "Text",
  number: "Number",
  boolean: "True or false",
  datetime: "Date and time",
  json: "JSON",
};

export const RUN_SOURCE_LABELS: Record<RunSource, string> = {
  api: "Source key",
  drop: "Source key",
  studio: "Studio upload",
  rederive: "Re-check",
};

/** A match rate below this reads as a key that may point at the wrong column (the board's 20%). */
export const LOW_MATCH_RATE = 0.2;

export interface LastRun {
  state: RunState;
  source: RunSource;
  writer: string;
  at: number;
  /** DIM-FR-24: from the run's counts, or null until the applier reports one. */
  matchRate: number | null;
}

export interface DatasetSummary {
  id: string;
  name: string;
  displayName: string;
  kind: DatasetKind;
  version: number;
  deliveryMode: DeliveryMode;
  lastRun: LastRun | null;
}

export interface DatasetOverview {
  datasets: DatasetSummary[];
  /** Runs held for review, across every dataset. */
  held: number;
  /** When the latest done nightly pass finished, or null when none has. */
  lastPassAt: number | null;
}

export interface VersionEntry {
  version: number;
  createdAt: number;
  createdBy: string | null;
  value: DatasetVersion;
}

export interface ColumnUses {
  metrics: { id: string; name: string }[];
  campaigns: { id: string; name: string }[];
  segments: { id: string; name: string }[];
}

export interface DatasetWriter {
  id: string;
  appId: string;
}

export interface DatasetDetail {
  id: string;
  name: string;
  displayName: string;
  kind: DatasetKind;
  version: number;
  /** Newest first. The first entry is the current version. */
  versions: VersionEntry[];
  lastRun: LastRun | null;
  writers: DatasetWriter[];
  uses: Record<string, ColumnUses>;
}

function instant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const time = new Date(value as string | Date).getTime();
  return Number.isNaN(time) ? null : time;
}

/** The applier's report puts the match rate on the run's counts as a share from 0 to 1. */
export function matchRateOf(counts: unknown): number | null {
  if (typeof counts !== "object" || counts === null) return null;
  const rate = (counts as Record<string, unknown>).match_rate;
  return typeof rate === "number" && rate >= 0 && rate <= 1 ? rate : null;
}

function lastRunOf(row: Record<string, unknown>): LastRun | null {
  const at = instant(row.run_created_at);
  if (at === null || !isOneOf(RUN_STATES, row.run_state) || !isOneOf(RUN_SOURCES, row.run_source)) return null;
  return { state: row.run_state, source: row.run_source, writer: String(row.run_writer), at, matchRate: matchRateOf(row.run_counts) };
}

const LAST_RUN = `LEFT JOIN LATERAL (
    SELECT state AS run_state, source AS run_source, writer AS run_writer, created_at AS run_created_at, counts AS run_counts
    FROM import_runs WHERE import_runs.record_type_id = t.id AND source <> 'rederive'
    ORDER BY created_at DESC LIMIT 1
  ) last_run ON true`;

export function summaryOf(row: Record<string, unknown>): DatasetSummary | null {
  if (!isDatasetKind(row.kind) || (row.delivery_mode !== "incremental" && row.delivery_mode !== "snapshot")) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    displayName: String(row.display_name),
    kind: row.kind,
    version: Number(row.current_version),
    deliveryMode: row.delivery_mode,
    lastRun: lastRunOf(row),
  };
}

export async function loadDatasetOverview(run: RunQuery): Promise<DatasetOverview> {
  const rows = await run({
    text: `SELECT t.id, t.name, t.display_name, t.kind, t.current_version, v.delivery_mode, last_run.*
           FROM import_record_types t
           JOIN import_record_type_versions v ON v.record_type_id = t.id AND v.version = t.current_version
           ${LAST_RUN}
           ORDER BY t.display_name, t.name`,
    values: [],
  });
  const [held] = await run({ text: `SELECT count(*)::int AS held FROM import_runs WHERE state = 'quarantined'`, values: [] });
  const [pass] = await run({
    text: `SELECT max(finished_at) AS finished_at FROM import_metric_passes WHERE state = 'done'`,
    values: [],
  });
  const datasets = rows.map(summaryOf).filter((summary): summary is DatasetSummary => summary !== null);
  return { datasets, held: Number(held?.held ?? 0), lastPassAt: instant(pass?.finished_at) };
}

/** Parses one stored version. A row the parser refuses is logged and left out. */
export function versionOf(kind: DatasetKind, row: Record<string, unknown>): VersionEntry | null {
  const parsed = parseDatasetVersion(kind, {
    columns: row.columns,
    roles: row.roles,
    deliveryMode: row.delivery_mode,
    timeZone: row.time_zone,
    delimiter: row.delimiter,
  });
  const createdAt = instant(row.created_at);
  if (!parsed.ok || createdAt === null) {
    console.error(`Dataset version ${String(row.version)} could not be read:`, parsed.ok ? "no created_at" : parsed.problems);
    return null;
  }
  return {
    version: Number(row.version),
    createdAt,
    createdBy: typeof row.created_by_email === "string" ? row.created_by_email : null,
    value: parsed.value,
  };
}

export const VERSIONS_QUERY = `SELECT v.version, v.columns, v.roles, v.delivery_mode, v.time_zone, v.delimiter, v.created_at,
         u.email AS created_by_email
  FROM import_record_type_versions v LEFT JOIN system_users u ON u.id = v.created_by
  WHERE v.record_type_id = $1 ORDER BY v.version DESC`;

/** The dataset and its versions, or null when it does not exist or its current version cannot be read. */
export async function loadDatasetBase(
  run: RunQuery,
  id: string,
): Promise<Omit<DatasetDetail, "uses" | "writers"> | null> {
  const [row] = await run({
    text: `SELECT t.id, t.name, t.display_name, t.kind, t.current_version, last_run.*
           FROM import_record_types t ${LAST_RUN} WHERE t.id = $1`,
    values: [id],
  });
  if (!row || !isDatasetKind(row.kind)) return null;
  const kind = row.kind;
  const versions = (await run({ text: VERSIONS_QUERY, values: [id] }))
    .map((version) => versionOf(kind, version))
    .filter((version): version is VersionEntry => version !== null);
  if (versions[0]?.version !== Number(row.current_version)) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    displayName: String(row.display_name),
    kind,
    version: Number(row.current_version),
    versions,
    lastRun: lastRunOf(row),
  };
}

export async function loadDatasetWriters(run: RunQuery, id: string): Promise<DatasetWriter[]> {
  const rows = await run({
    text: `SELECT k.id, k.app_id FROM import_source_scopes s JOIN ingestion_source_keys k ON k.id = s.source_key_id
           WHERE s.record_type_id = $1 AND k.revoked_at IS NULL ORDER BY k.app_id`,
    values: [id],
  });
  return rows.map((row) => ({ id: String(row.id), appId: String(row.app_id) }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDatasetId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function datasetHref(id: string): string {
  return `/v2/data/datasets/${id}`;
}

/** The role a column holds in a version, for the Role column of the editor. */
export function roleOf(roles: DatasetRoles, column: string): Role | null {
  for (const role of SINGLE_ROLES) if (roles[role] === column) return role;
  for (const role of LIST_ROLES) if (roles[role]?.includes(column)) return role;
  return null;
}

/** The Versions card: what a version changed against the one before it. */
export function describeVersion(previous: DatasetVersion | null, next: DatasetVersion): string[] {
  if (previous === null) return [`Created with ${next.columns.length} ${next.columns.length === 1 ? "column" : "columns"}`];
  const lines: string[] = [];
  const before = new Map(previous.columns.map((column) => [column.name, column]));
  const after = new Map(next.columns.map((column) => [column.name, column]));
  for (const column of next.columns) {
    const old = before.get(column.name);
    if (!old) lines.push(`Added ${column.displayName}, ${COLUMN_TYPE_LABELS[column.type]}`);
    else if (old.type !== column.type) lines.push(`${column.displayName} is now ${COLUMN_TYPE_LABELS[column.type]}`);
    if (old) {
      for (const alias of column.aliases.filter((alias) => !old.aliases.includes(alias))) {
        lines.push(`${column.displayName} also accepts ${alias}`);
      }
    }
  }
  for (const column of previous.columns) {
    if (!after.has(column.name)) lines.push(`Removed ${column.displayName}, ${COLUMN_TYPE_LABELS[column.type]}`);
  }
  for (const role of [...SINGLE_ROLES, ...LIST_ROLES]) {
    if (JSON.stringify(previous.roles[role] ?? null) !== JSON.stringify(next.roles[role] ?? null)) {
      lines.push(`${ROLE_LABELS[role]} changed`);
    }
  }
  if (previous.deliveryMode !== next.deliveryMode) lines.push(`Files now hold: ${DELIVERY_MODE_LABELS[next.deliveryMode]}`);
  if (previous.timeZone !== next.timeZone) lines.push(`Time zone is now ${next.timeZone}`);
  if (previous.delimiter !== next.delimiter) lines.push(`CSV separator is now ${next.delimiter === "," ? "comma" : "semicolon"}`);
  return lines.length > 0 ? lines : ["No column changes"];
}

/**
 * DIM-FR-06: what the editor says before saving a change that would re-derive. No file is kept in
 * a drop zone yet, so studio cannot read old files again: the version applies to new deliveries only.
 */
export const NEW_DELIVERIES_ONLY =
  "Studio keeps no copy of the files this dataset received, so it cannot read them again. The new version applies to files that arrive after you save. Stored rows stay as they are.";

/** The label of the save button for a change, or null when there is nothing to save. */
export function saveLabel(change: VersionChange | null, dirty: boolean, version: number): string | null {
  if (change?.newVersion) return `Save as version ${version + 1}`;
  return dirty ? "Save changes" : null;
}

export interface Refusal {
  column: string;
  uses: string[];
}

export function usesOf(uses: ColumnUses): string[] {
  return [
    ...uses.metrics.map((metric) => `Metric ${metric.name}`),
    ...uses.campaigns.map((campaign) => `Journey ${campaign.name}`),
    ...uses.segments.map((segment) => `Segment ${segment.name}`),
  ];
}
