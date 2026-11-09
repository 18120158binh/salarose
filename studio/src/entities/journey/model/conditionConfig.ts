import { NUMERIC_DATA_TYPES } from "shared/lib/metricDefinitions";
import type { ConditionGroups, EventPropertyCondition, FieldOperator, FieldValue, PersonCondition } from "./types";
import { valueText } from "./eventCondition";

// The editor's "contains". It is saved as LIKE, never under this name.
export const CONTAINS = "CONTAINS";

// Keyed by the operator the editor shows. LIKE is offered for no type: the editor shows only a
// LIKE saved by an older build, whose pattern without wildcards matches only the exact value.
// The decision job orders two numbers, or two ISO 8601 datetimes, so the ordering operators read
// as before and after on a datetime.
export const OPERATOR_CONFIG: Record<string, { label: string; datetimeLabel?: string; types: (FieldDef["type"] | "all")[] }> = {
  "=":      { label: "equals",          types: ["all"] },
  "!=":     { label: "does not equal",  types: ["all"] },
  ">=":     { label: "is at least",     datetimeLabel: "is on or after",  types: ["number", "datetime"] },
  ">":      { label: "is more than",    datetimeLabel: "is after",        types: ["number", "datetime"] },
  "<=":     { label: "is at most",      datetimeLabel: "is on or before", types: ["number", "datetime"] },
  "<":      { label: "is less than",    datetimeLabel: "is before",       types: ["number", "datetime"] },
  [CONTAINS]: { label: "contains",      types: ["string"] },
  "LIKE":   { label: "matches exactly", types: [] },
  "IN":     { label: "is one of",       types: ["string"] },
};

// The condition language reads LIKE as a pattern over the whole value, where % matches any run of
// characters and _ matches one. It has no escape, so a % or _ in the typed text stays a wildcard.
interface SavedComparison {
  op: FieldOperator;
  value: FieldValue;
}

// The text between the % of a "contains" pattern, or null for any other comparison.
function containsText(row: SavedComparison): string | null {
  const { op, value } = row;
  return op === "LIKE" && typeof value === "string" && value.length >= 2 && value.startsWith("%") && value.endsWith("%")
    ? value.slice(1, -1)
    : null;
}

/** The operator the editor shows for a saved comparison. */
export function editorOperator(row: SavedComparison): string {
  return containsText(row) !== null ? CONTAINS : row.op;
}

/** The value the editor shows for a saved comparison: the text of a contains, without the %. */
export function editorValue(row: SavedComparison): string {
  return containsText(row) ?? valueText(row.value);
}

/** The saved operator for what the editor shows, and the text to save, with the % of a contains. */
export function savedComparison(operator: string, value: string): { op: FieldOperator; text: string } {
  return operator === CONTAINS
    ? { op: "LIKE", text: `%${value}%` }
    : { op: operator as FieldOperator, text: value };
}

/** The label the editor shows for an operator on a field of this type. */
export function operatorLabel(operator: string, fieldType: FieldDef["type"]): string {
  const config = OPERATOR_CONFIG[operator];
  if (!config) return operator;
  return (fieldType === "datetime" && config.datetimeLabel) || config.label;
}

export interface FieldDef {
  value: string;
  label: string;
  group: "event" | "user" | "page";
  type: "string" | "number" | "boolean" | "datetime";
}

/**
 * Maps a catalog attribute's data type to the operator family the condition editor offers.
 */
export function eventFieldType(field: { dataType?: string; type?: string }): FieldDef["type"] {
  const dataType = String(field.dataType || field.type || "").toLowerCase();
  if (NUMERIC_DATA_TYPES.includes(dataType)) return "number";
  if (dataType === "boolean") return "boolean";
  if (dataType === "datetime") return "datetime";
  return "string";
}

export const FIELD_GROUPS: Record<string, string> = {
  event: "Event Properties",
  user:  "User Attributes",
  page:  "Page Properties",
};

export interface AggregationTemplate {
  label: string;
  needsField: boolean;
  numericOnly?: boolean;
  sentencePrefix: string;
  sentenceSuffix?: string;
}

export const AGGREGATION_TEMPLATES: Record<string, AggregationTemplate> = {
  COUNT: {
    label: "Times performed (Frequency)",
    needsField: false,
    sentencePrefix: "Performed this action",
    sentenceSuffix: "time(s)",
  },
  INACTION: {
    label: "Has not performed (0 times)",
    needsField: false,
    sentencePrefix: "Has not performed this action",
  },
  SUM: {
    label: "Total sum of a property",
    needsField: true,
    numericOnly: true,
    sentencePrefix: "Total sum of",
  },
  AVG: {
    label: "Average value of a property",
    needsField: true,
    numericOnly: true,
    sentencePrefix: "Average value of",
  },
  MEDIAN: {
    label: "Median value of a property",
    needsField: true,
    numericOnly: true,
    sentencePrefix: "Median value of",
  },
  MIN: {
    label: "Minimum property value",
    needsField: true,
    numericOnly: true,
    sentencePrefix: "Minimum value of",
  },
  MAX: {
    label: "Maximum property value",
    needsField: true,
    numericOnly: true,
    sentencePrefix: "Maximum value of",
  },
  DISTINCT_COUNT: {
    label: "Number of unique property values",
    needsField: true,
    sentencePrefix: "Number of unique",
    sentenceSuffix: "values",
  },
};

export const AGGREGATION_OPERATOR_LABELS: Record<string, string> = {
  ">=": "at least",
  ">": "more than",
  "=": "exactly",
  "!=": "not equal to",
  "<=": "at most",
  "<": "less than",
};

export const TIME_UNIT_LABELS: Record<string, string> = {
  MINUTES: "minute(s)",
  HOURS: "hour(s)",
  DAYS: "day(s)",
  WEEKS: "week(s)",
  MONTHS: "month(s)",
};

// One line per node: the groups joined with &, the conditions of a group with |. Catalog default
// rows are left out, as the marketer did not write them.
export function getConditionSummary(
  groups: ConditionGroups<EventPropertyCondition | PersonCondition> | null | undefined,
  maxLen = 35,
): string {
  const parts = (groups?.groups ?? [])
    .map((group) => group.conditions
      .filter((condition) => !("isDefault" in condition && condition.isDefault === true))
      .map(summarizeCondition)
      .filter((text) => text))
    .filter((texts) => texts.length > 0)
    .map((texts) => (texts.length > 1 ? `(${texts.join(" | ")})` : texts[0]));
  const full = parts.length === 1 ? parts[0].replace(/^\((.*)\)$/, "$1") : parts.join(" & ");
  return full.length > maxLen ? full.slice(0, maxLen - 1) + "…" : full;
}

function summarizeCondition(condition: EventPropertyCondition | PersonCondition): string {
  if (condition.type === "behavior") {
    return `${condition.event} ${condition.measure} ${AGGREGATION_OPERATOR_LABELS[condition.op] || condition.op} ${condition.value}`;
  }
  const field = condition.field.split(".").pop() || "";
  const op = editorOperator(condition);
  const opLabel = OPERATOR_CONFIG[op]?.label || op;
  return `${field} ${opLabel} ${editorValue(condition) || "?"}`;
}
