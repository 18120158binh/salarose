// The functions the decision job computes. It computes COUNT for any other name.
export const METRIC_DEFINITION_FUNCTIONS = [
  "COUNT",
  "INACTION",
  "SUM",
  "AVG",
  "MEDIAN",
  "MIN",
  "MAX",
  "DISTINCT_COUNT",
  "LATEST",
  "PRICE_DROP",
  "DIFF",
] as const;

export type MetricAggregationFunction = (typeof METRIC_DEFINITION_FUNCTIONS)[number];

export function isMetricFunction(value: string): value is MetricAggregationFunction {
  return (METRIC_DEFINITION_FUNCTIONS as readonly string[]).includes(value);
}

// The function the decision job computes for a name: the name in upper case, or COUNT when it
// knows no such function.
export function normalizeMetricFunction(
  value?: string | null,
): MetricAggregationFunction {
  const normalized = String(value || "COUNT").trim().toUpperCase();
  return isMetricFunction(normalized) ? normalized : "COUNT";
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The entries of a list of groups, { "groups": [{ "conditions": [...] }] }.
function groupEntries(list: unknown): JsonObject[] {
  if (!isObject(list) || !Array.isArray(list.groups)) return [];
  return list.groups.flatMap((group) =>
    isObject(group) && Array.isArray(group.conditions) ? group.conditions.filter(isObject) : []);
}

/**
 * The behavior conditions of a node row's parsed conditions_json and paths_json: the node's own
 * and those of its multi-branch branches. The objects are the parsed JSON, so a change to one
 * changes what is written back.
 */
export function behaviorConditionsIn(conditions: unknown, paths: unknown): JsonObject[] {
  const branches = isObject(paths) && Array.isArray(paths.branches) ? paths.branches.filter(isObject) : [];
  return [conditions, ...branches.map((branch) => branch.conditions)]
    .flatMap(groupEntries)
    .filter((entry) => entry.type === "behavior");
}

function parseOptionalJson(text: string | null): unknown {
  return text == null ? null : JSON.parse(text);
}

// What a metric stores for each occurrence. A metric without an attribute only counts events.
export type MetricValueType = "PRESENCE" | "NUMBER" | "STRING" | "BOOLEAN";

// The catalog data types that hold a number.
export const NUMERIC_DATA_TYPES = ["number", "integer", "float", "double", "decimal", "numeric"];

// A metric with an attribute stores the attribute's value, typed by the attribute's catalog
// type. An attribute the catalog does not list keeps its raw text, which every function can
// still read as a number.
export function metricValueType(
  field: string | null,
  catalogDataType?: string | null,
): MetricValueType {
  if (!field) return "PRESENCE";
  const dataType = String(catalogDataType ?? "").toLowerCase();
  if (NUMERIC_DATA_TYPES.includes(dataType)) return "NUMBER";
  if (dataType === "boolean") return "BOOLEAN";
  return "STRING";
}

// A campaign node row as the metric reference read returns it.
export interface MetricReferenceRow {
  campaign_id: string;
  node_id: string;
  status: string;
  conditions_json: string | null;
  paths_json: string | null;
}

// The milliseconds in each window unit. A week is 7 days and a month is 30 days.
const WINDOW_UNIT_MILLIS: Record<string, number> = {
  SECONDS: 1_000,
  MINUTES: 60_000,
  HOURS: 3_600_000,
  DAYS: 86_400_000,
  WEEKS: 7 * 86_400_000,
  MONTHS: 30 * 86_400_000,
};

// A window's length in milliseconds, or null for a stored window that is not a number above 0
// in a known unit.
function windowMillis(window: unknown): number | null {
  if (!isObject(window) || typeof window.value !== "number" || !(window.value > 0)) return null;
  const unit = typeof window.unit === "string" ? WINDOW_UNIT_MILLIS[window.unit] : undefined;
  return unit === undefined ? null : Math.min(window.value * unit, Number.MAX_SAFE_INTEGER);
}

/**
 * Records that a condition with this window keeps the metric live: its retention is the longest
 * window recorded for it, or null while no recorded window is valid.
 */
export function addMetricWindow(retentions: Map<string, number | null>, metricId: string, window: unknown): void {
  const millis = windowMillis(window);
  const current = retentions.get(metricId) ?? null;
  retentions.set(metricId, millis === null ? current : Math.max(current ?? 0, millis));
}

// The metrics that the behavior conditions of active campaigns' node rows name, each with the
// longest of their windows. A row whose JSON does not parse is logged and skipped, so that one bad
// row cannot fail every campaign write.
export function activeMetricRetentions(rows: MetricReferenceRow[]): Map<string, number | null> {
  const retentions = new Map<string, number | null>();
  for (const row of rows) {
    if (row.status !== "active") continue;
    let behaviors: JsonObject[];
    try {
      behaviors = behaviorConditionsIn(parseOptionalJson(row.conditions_json), parseOptionalJson(row.paths_json));
    } catch (error) {
      console.warn(
        `Skipping campaign ${row.campaign_id} node ${row.node_id} in metric references: its JSON does not parse.`,
        error,
      );
      continue;
    }
    for (const condition of behaviors) {
      const metricId = condition.metric_id;
      if (typeof metricId === "string" && metricId.trim()) addMetricWindow(retentions, metricId, condition.window);
    }
  }
  return retentions;
}

// A metric's default_properties or filter_conditions, in the predicate language the decision
// job reads. The job loads a definition whose condition is neither {} nor this tree as disabled.
export type MetricEventCondition =
  | { type: "comparison"; left: string; op: string; right: string }
  | { type: "and" | "or"; expressions: MetricEventCondition[] };

// Each attribute path equals its value, joined with AND. {} when there is none.
export function attributeValuesCondition(
  values: Record<string, string>,
): MetricEventCondition | Record<string, never> {
  const entries = Object.entries(values);
  if (entries.length === 0) return {};
  return {
    type: "and",
    expressions: entries.map(([left, right]) => ({ type: "comparison", left, op: "=", right })),
  };
}

export function metricDisplayName(
  eventLabel: string,
  aggregationFunction: string,
  fieldLabel?: string | null,
): string {
  return `${eventLabel} — ${metricMeasure(aggregationFunction, fieldLabel)}`;
}

// What a metric computes, such as "Sum of product.price", without the event.
export function metricMeasure(aggregationFunction: string, fieldLabel?: string | null): string {
  const field = fieldLabel || "value";
  switch (normalizeMetricFunction(aggregationFunction)) {
    case "COUNT":
      return "Times performed";
    case "INACTION":
      return "Not performed";
    case "SUM":
      return `Sum of ${field}`;
    case "AVG":
      return `Average of ${field}`;
    case "MEDIAN":
      return `Median of ${field}`;
    case "MIN":
      return `Minimum of ${field}`;
    case "MAX":
      return `Maximum of ${field}`;
    case "DISTINCT_COUNT":
      return `Unique values of ${field}`;
    case "LATEST":
      return `Latest ${field}`;
    case "PRICE_DROP":
      return `Drop in ${field}`;
    case "DIFF":
      return `Change in ${field}`;
  }
}
