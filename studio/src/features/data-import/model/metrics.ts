import type { SqlQuery } from "@/lib/db";
import {
  COLUMN_TYPES,
  isOneOf,
  METRIC_FUNCTION_COLUMN,
  METRIC_FUNCTIONS,
  type ColumnType,
  type DatasetColumn,
  type MetricFunction,
  type StatusTone,
} from "./domain";
import { instant, isUuid } from "./imports";
import { importedField, type FieldUses } from "./uses";
import { isSystemName, SYSTEM_NAME_RULE } from "./version";

// /data/metrics (DIM-FR-17, DIM-FR-18, CMP-FR-21 to CMP-FR-23): event metrics from
// user_metric_definitions, read-only, and dataset metrics from import_metric_definitions, which
// staff create, edit, archive, and unarchive. Nothing deletes either kind.

const DAY_MS = 86_400_000;

export const EVENT_ARCHIVE_GAP = "Archiving an event metric isn't available yet: the event metric table has no archive mark that the pipeline honors.";

export const METRIC_PAGE_DESCRIPTION =
  "Every number Studio keeps for each customer, in one list. Event metrics count website and app events as they happen. Studio makes them when a journey or segment with a behavior condition is published. Dataset metrics are worked out each night from your datasets, and you create them here.";

export const MAX_WINDOW_DAYS = 3650;

export type MetricSource = "event" | "dataset";
export type MetricState = "live" | "paused" | "not_updating" | "archived";

export const METRIC_STATE_LABELS: Record<MetricState, { label: string; tone: StatusTone }> = {
  live: { label: "Live", tone: "ok" },
  paused: { label: "Paused", tone: "off" },
  not_updating: { label: "Not updating", tone: "warn" },
  archived: { label: "Archived", tone: "off" },
};

const STATE_ORDER: Record<MetricState, number> = { live: 0, not_updating: 1, paused: 2, archived: 3 };

/** The board's calculation names. */
export const METRIC_FUNCTION_LABELS: Record<MetricFunction, { label: string; hint: string }> = {
  COUNT: { label: "Count", hint: "how many rows" },
  SUM: { label: "Sum", hint: "adds a number" },
  AVG: { label: "Average", hint: "of a number" },
  MIN: { label: "Lowest", hint: "of a number" },
  MAX: { label: "Highest", hint: "of a number" },
  MEDIAN: { label: "Median", hint: "of a number" },
  DISTINCT_COUNT: { label: "Distinct", hint: "different values" },
  LATEST: { label: "Latest", hint: "newest value" },
  FIRST_TIME: { label: "First time", hint: "earliest row" },
  LAST_TIME: { label: "Last time", hint: "newest row" },
};

/** The catalog operators a dataset metric's filter may use (customer decision, Condition language). */
export const FILTER_OPS = ["=", "!=", ">", ">=", "<", "<="] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  "=": "is",
  "!=": "is not",
  ">": "is more than",
  ">=": "is at least",
  "<": "is less than",
  "<=": "is at most",
};

export interface MetricFilter {
  column: string;
  op: FilterOp;
  value: string | number;
}

export interface MetricUse {
  kind: "journey" | "segment";
  id: string;
  name: string;
}

export interface EventMetric {
  source: "event";
  id: string;
  displayName: string;
  eventName: string;
  eventDisplayName: string | null;
  aggOperator: string;
  aggField: string | null;
  hasFilters: boolean;
  retentionDays: number | null;
  state: "live" | "paused";
  createdBy: string | null;
  uses: MetricUse[];
}

export interface DatasetMetric {
  source: "dataset";
  id: string;
  dataset: { id: string; name: string; displayName: string };
  name: string;
  displayName: string;
  function: MetricFunction;
  column: string | null;
  filters: MetricFilter[];
  windowDays: number | null;
  archivedAt: number | null;
  createdBy: string | null;
  createdAt: number | null;
  state: MetricState;
  uses: MetricUse[];
}

export type MetricRow = EventMetric | DatasetMetric;

/** An event dataset a metric can be made on, with its current version's columns. */
export interface MetricDataset {
  id: string;
  name: string;
  displayName: string;
  columns: DatasetColumn[];
  eventTimeColumn: string | null;
}

export function metricKey(metric: MetricRow): string {
  return `${metric.source}:${metric.id}`;
}

export function systemNameOf(metric: MetricRow): string {
  return metric.source === "event" ? metric.id : importedField(metric.dataset.name, metric.name);
}

export function compareMetrics(a: MetricRow, b: MetricRow): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.displayName.localeCompare(b.displayName);
}

export function usesOf(uses: FieldUses): MetricUse[] {
  return [
    ...uses.campaigns.map((use) => ({ kind: "journey" as const, ...use })),
    ...uses.segments.map((use) => ({ kind: "segment" as const, ...use })),
  ];
}

/** "1 journey and 2 segments". */
export function describeUses(uses: readonly MetricUse[]): string {
  const journeys = uses.filter((use) => use.kind === "journey").length;
  const segments = uses.length - journeys;
  const parts: string[] = [];
  if (journeys > 0) parts.push(`${journeys} ${journeys === 1 ? "journey" : "journeys"}`);
  if (segments > 0) parts.push(`${segments} ${segments === 1 ? "segment" : "segments"}`);
  return parts.join(" and ");
}

/** The refusal of DIM-FR-18 and CMP-FR-21, naming each use. */
export function usedRefusal(verb: string, uses: readonly MetricUse[]): string {
  const named = uses.map((use) => `${use.kind === "journey" ? "journey" : "segment"} ${use.name}`).join(", ");
  return `This metric can't be ${verb} while something uses it: ${named}.`;
}

/**
 * CMP-FR-23: a dataset metric is not updating when the newest done pass is more than a day old,
 * or when no pass has finished yet.
 */
export function datasetMetricState(archivedAt: number | null, latestDoneAsOf: number | null, now: number): MetricState {
  if (archivedAt !== null) return "archived";
  if (latestDoneAsOf === null || now - latestDoneAsOf > DAY_MS) return "not_updating";
  return "live";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== "object" || value === null) return false;
  const groups = (value as Record<string, unknown>).groups;
  return Array.isArray(groups) ? groups.length > 0 : Object.keys(value).length > 0;
}

export const EVENT_METRICS_QUERY: SqlQuery = {
  text: `SELECT d.id, d.display_name, d.event_name, d.agg_operator, d.agg_field, d.filter_conditions, d.retention_ms,
                d.processing_mode, u.email AS created_by,
                (SELECT e.display_name FROM user_events e WHERE e.event_name = d.event_name) AS event_display_name
         FROM user_metric_definitions d
         LEFT JOIN system_users u ON u.id = d.created_by`,
  values: [],
};

/**
 * CMP-FR-21: an event metric is in use while a condition of an active or paused campaign, or of
 * any segment, names its id. A metric id is `m_` and 16 hex digits, so its text in the saved JSON
 * names nothing else.
 */
export const EVENT_METRIC_USES_QUERY: SqlQuery = {
  text: `SELECT DISTINCT d.id AS metric_id, 'journey' AS kind, c.id::text AS use_id, c.name AS use_name
         FROM user_metric_definitions d
         JOIN campaign_nodes n ON strpos(coalesce(n.conditions_json, '') || coalesce(n.trigger_json, '') || coalesce(n.paths_json, ''), d.id) > 0
         JOIN campaigns c ON c.id = n.campaign_id
         WHERE c.status IN ('active', 'paused')
         UNION
         SELECT d.id, 'segment', s.id::text, s.name
         FROM user_metric_definitions d
         JOIN segments s ON strpos(s.conditions_json::text, d.id) > 0`,
  values: [],
};

export function parseEventMetrics(rows: Record<string, unknown>[], useRows: Record<string, unknown>[]): EventMetric[] {
  const uses = new Map<string, MetricUse[]>();
  for (const row of useRows) {
    if (typeof row.metric_id !== "string" || typeof row.use_id !== "string" || (row.kind !== "journey" && row.kind !== "segment")) continue;
    const list = uses.get(row.metric_id) ?? [];
    list.push({ kind: row.kind, id: row.use_id, name: typeof row.use_name === "string" ? row.use_name : row.use_id });
    uses.set(row.metric_id, list);
  }
  return rows.flatMap((row): EventMetric[] => {
    if (typeof row.id !== "string") return [];
    const retention = typeof row.retention_ms === "string" || typeof row.retention_ms === "number" ? Number(row.retention_ms) : NaN;
    return [
      {
        source: "event",
        id: row.id,
        displayName: text(row.display_name) ?? row.id,
        eventName: typeof row.event_name === "string" ? row.event_name : "",
        eventDisplayName: text(row.event_display_name),
        aggOperator: (text(row.agg_operator) ?? "COUNT").toUpperCase(),
        aggField: text(row.agg_field),
        hasFilters: hasEntries(row.filter_conditions),
        retentionDays: Number.isFinite(retention) && retention > 0 ? Math.round(retention / DAY_MS) : null,
        state: row.processing_mode === "LIVE" ? "live" : "paused",
        createdBy: text(row.created_by),
        uses: uses.get(row.id) ?? [],
      },
    ];
  });
}

export const DATASET_METRICS_QUERY: SqlQuery = {
  text: `SELECT m.id, m.record_type_id, t.name AS dataset_name, t.display_name AS dataset_display_name, m.name, m.display_name,
                m.function, m."column", m.filters, m.window_days, m.archived_at, m.created_at, u.email AS created_by
         FROM import_metric_definitions m
         JOIN import_record_types t ON t.id = m.record_type_id
         LEFT JOIN system_users u ON u.id = m.created_by`,
  values: [],
};

function parseStoredFilters(value: unknown): MetricFilter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MetricFilter[] => {
    if (typeof item !== "object" || item === null) return [];
    const { column, op, value: operand } = item as Record<string, unknown>;
    if (typeof column !== "string" || !isOneOf(FILTER_OPS, op)) return [];
    if (typeof operand !== "string" && typeof operand !== "number") return [];
    return [{ column, op, value: operand }];
  });
}

/** Rows without their uses and state, which the server adds. */
export function parseDatasetMetric(row: Record<string, unknown>): Omit<DatasetMetric, "uses" | "state"> | null {
  if (
    typeof row.id !== "string" ||
    typeof row.record_type_id !== "string" ||
    typeof row.dataset_name !== "string" ||
    typeof row.name !== "string" ||
    !isOneOf(METRIC_FUNCTIONS, row.function)
  ) {
    return null;
  }
  const window = typeof row.window_days === "number" && row.window_days >= 1 ? row.window_days : null;
  return {
    source: "dataset",
    id: row.id,
    dataset: {
      id: row.record_type_id,
      name: row.dataset_name,
      displayName: text(row.dataset_display_name) ?? row.dataset_name,
    },
    name: row.name,
    displayName: text(row.display_name) ?? row.name,
    function: row.function,
    column: text(row.column),
    filters: parseStoredFilters(row.filters),
    windowDays: window,
    archivedAt: instant(row.archived_at),
    createdBy: text(row.created_by),
    createdAt: instant(row.created_at),
  };
}

export const METRIC_DATASETS_QUERY: SqlQuery = {
  text: `SELECT t.id, t.name, t.display_name, v.columns, v.roles
         FROM import_record_types t
         JOIN import_record_type_versions v ON v.record_type_id = t.id AND v.version = t.current_version
         WHERE t.kind = 'event'
         ORDER BY t.display_name`,
  values: [],
};

function parseColumns(value: unknown): DatasetColumn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DatasetColumn[] => {
    if (typeof item !== "object" || item === null) return [];
    const { name, displayName, type, pii, aliases } = item as Record<string, unknown>;
    if (!isSystemName(name) || !isOneOf(COLUMN_TYPES, type)) return [];
    return [
      {
        name,
        displayName: typeof displayName === "string" && displayName.trim() !== "" ? displayName : name,
        type,
        pii: pii === true,
        aliases: Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string") : [],
      },
    ];
  });
}

export function parseMetricDataset(row: Record<string, unknown>): MetricDataset | null {
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  const roles = typeof row.roles === "object" && row.roles !== null ? (row.roles as Record<string, unknown>) : {};
  return {
    id: row.id,
    name: row.name,
    displayName: text(row.display_name) ?? row.name,
    columns: parseColumns(row.columns),
    eventTimeColumn: typeof roles.event_time === "string" ? roles.event_time : null,
  };
}

/** What the editor sends. Parsed by parseMetricInput against the dataset's current columns. */
export interface MetricInput {
  recordTypeId: string;
  name: string;
  displayName: string;
  function: MetricFunction;
  column: string | null;
  filters: MetricFilter[];
  windowDays: number | null;
}

export type ParsedInput = { ok: true; value: MetricInput } | { ok: false; problems: string[] };

const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes or no",
  datetime: "Date and time",
  json: "JSON",
};

export function columnTypeLabel(type: ColumnType): string {
  return COLUMN_TYPE_LABELS[type];
}

/** Why a column does not fit a function, or null when it does. */
export function columnRefusal(fn: MetricFunction, column: DatasetColumn): string | null {
  return METRIC_FUNCTION_COLUMN[fn] === "number" && column.type !== "number"
    ? `${METRIC_FUNCTION_LABELS[fn].label} needs a number`
    : null;
}

function parseFilter(input: unknown, columns: Map<string, DatasetColumn>, problems: string[]): MetricFilter | null {
  if (typeof input !== "object" || input === null) {
    problems.push("A filter is incomplete.");
    return null;
  }
  const { column, op, value } = input as Record<string, unknown>;
  const target = typeof column === "string" ? columns.get(column) : undefined;
  if (!target) {
    problems.push("A filter names a column the dataset does not have.");
    return null;
  }
  if (!isOneOf(FILTER_OPS, op)) {
    problems.push(`The filter on ${target.displayName} needs an operator.`);
    return null;
  }
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    problems.push(`The filter on ${target.displayName} needs a value.`);
    return null;
  }
  if (target.type === "number") {
    const number = Number(raw);
    if (!Number.isFinite(number)) {
      problems.push(`The filter on ${target.displayName} needs a number.`);
      return null;
    }
    return { column: target.name, op, value: number };
  }
  return { column: target.name, op, value: raw };
}

/**
 * DIM-FR-17: a metric's name follows the system name rule, its function takes the column type
 * its table names, and its filters name the dataset's columns. Name uniqueness is the database's
 * constraint, checked by the action.
 */
export function parseMetricInput(input: unknown, dataset: MetricDataset): ParsedInput {
  const problems: string[] = [];
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const { name, displayName, function: fn, column, filters, windowDays } = fields;
  const columns = new Map(dataset.columns.map((entry) => [entry.name, entry]));

  if (!isSystemName(name)) problems.push(`Name in conditions: ${SYSTEM_NAME_RULE}`);
  if (typeof displayName !== "string" || displayName.trim() === "") problems.push("Give the metric a name.");
  if (!isOneOf(METRIC_FUNCTIONS, fn)) problems.push("Pick a calculation.");

  let parsedColumn: string | null = null;
  if (isOneOf(METRIC_FUNCTIONS, fn)) {
    const needs = METRIC_FUNCTION_COLUMN[fn];
    if (needs === "none") {
      if (column !== null && column !== undefined && column !== "") problems.push(`${METRIC_FUNCTION_LABELS[fn].label} takes no column.`);
    } else {
      const target = typeof column === "string" ? columns.get(column) : undefined;
      if (!target) problems.push(`${METRIC_FUNCTION_LABELS[fn].label} needs a column.`);
      else {
        const refusal = columnRefusal(fn, target);
        if (refusal) problems.push(`${target.displayName} is ${columnTypeLabel(target.type)}. ${refusal}.`);
        else parsedColumn = target.name;
      }
    }
  }

  const parsedFilters = (Array.isArray(filters) ? filters : [])
    .map((filter) => parseFilter(filter, columns, problems))
    .filter((filter): filter is MetricFilter => filter !== null);

  let parsedWindow: number | null = null;
  if (windowDays !== null && windowDays !== undefined && windowDays !== "") {
    const days = typeof windowDays === "number" ? windowDays : Number(windowDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      problems.push(`The window is a whole number of days from 1 to ${MAX_WINDOW_DAYS}, or all time.`);
    } else {
      parsedWindow = days;
    }
  }

  if (problems.length > 0 || !isSystemName(name) || typeof displayName !== "string" || !isOneOf(METRIC_FUNCTIONS, fn)) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    value: {
      recordTypeId: dataset.id,
      name,
      displayName: displayName.trim(),
      function: fn,
      column: parsedColumn,
      filters: parsedFilters,
      windowDays: parsedWindow,
    },
  };
}

export function recordTypeIdOf(input: unknown): string | null {
  const id = typeof input === "object" && input !== null ? (input as Record<string, unknown>).recordTypeId : undefined;
  return isUuid(id) ? id : null;
}

/** "Sum of Order total, where Status is completed". */
export function calculationText(
  metric: Pick<DatasetMetric, "function" | "column" | "filters">,
  columns: readonly DatasetColumn[],
): string {
  const label = (name: string) => columns.find((column) => column.name === name)?.displayName ?? name;
  const fn = METRIC_FUNCTION_LABELS[metric.function].label;
  const base = metric.column === null ? fn : `${fn} of ${label(metric.column)}`;
  if (metric.filters.length === 0) return base;
  const where = metric.filters.map((filter) => `${label(filter.column)} ${FILTER_OP_LABELS[filter.op]} ${filter.value}`).join(" and ");
  return `${base}, where ${where}`;
}

export function windowText(windowDays: number | null): string {
  if (windowDays === null) return "All time";
  return windowDays === 1 ? "1 day" : `${windowDays} days`;
}

/** "Sum of product.price, with filters". */
export function eventCalculationText(metric: Pick<EventMetric, "aggOperator" | "aggField" | "hasFilters">): string {
  const fn = isOneOf(METRIC_FUNCTIONS, metric.aggOperator) ? METRIC_FUNCTION_LABELS[metric.aggOperator].label : metric.aggOperator;
  const base = metric.aggField === null ? fn : `${fn} of ${metric.aggField}`;
  return metric.hasFilters ? `${base}, with filters` : base;
}

export const INSERT_METRIC_TEXT = `INSERT INTO import_metric_definitions
    (record_type_id, name, display_name, function, "column", filters, window_days, created_by)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
  ON CONFLICT ON CONSTRAINT import_metric_definitions_name_key DO NOTHING
  RETURNING id`;

export function insertMetricQuery(input: MetricInput, userId: string): SqlQuery {
  return {
    text: INSERT_METRIC_TEXT,
    values: [
      input.recordTypeId,
      input.name,
      input.displayName,
      input.function,
      input.column,
      JSON.stringify(input.filters),
      input.windowDays,
      userId,
    ],
  };
}

export function updateMetricQuery(id: string, input: MetricInput): SqlQuery {
  return {
    text: `UPDATE import_metric_definitions
           SET name = $2, display_name = $3, function = $4, "column" = $5, filters = $6::jsonb, window_days = $7
           WHERE id = $1 AND archived_at IS NULL
           RETURNING id`,
    values: [id, input.name, input.displayName, input.function, input.column, JSON.stringify(input.filters), input.windowDays],
  };
}
