import type { MetricAggregationFunction } from "shared/lib/metricDefinitions";
import type {
  BehaviorCondition,
  BehaviorOperator,
  PropertyOperator,
  Segment,
  SegmentCondition,
  SegmentId,
  SegmentProfileField,
  WindowUnit,
} from "shared/lib/segments";
import { measureReadsAttribute, newSegmentId } from "shared/lib/segments";

// What the editor holds while the marketer types: every number and list as the text typed, so
// that a refused save keeps it exactly.
export interface ProfileConditionDraft {
  type: "profile_property";
  field: SegmentProfileField;
  op: PropertyOperator;
  value: string;
}

export interface BehaviorConditionDraft {
  type: "behavior";
  event: string;
  measure: MetricAggregationFunction;
  attribute: string;
  windowValue: string;
  windowUnit: WindowUnit;
  op: BehaviorOperator;
  value: string;
  /** SEG-FR-11: each filter narrows which events count. Every filter must pass. */
  filters: FilterDraft[];
  /** Stored filters with an OR inside a group, which the editor can't show. It keeps them as they are. */
  keptFilters?: BehaviorCondition["filters"];
}

/** One event filter as the marketer types it: compares a field of the event with a value. */
export interface FilterDraft {
  field: string;
  op: PropertyOperator;
  value: string;
}

export function newFilter(field = ""): FilterDraft {
  return { field, op: "=", value: "" };
}

export type ConditionDraft = ProfileConditionDraft | BehaviorConditionDraft;

export interface SegmentDraft {
  id: SegmentId;
  /** True until the segment is first saved. */
  create: boolean;
  name: string;
  description: string;
  groups: ConditionDraft[][];
}

export function newProfileCondition(): ProfileConditionDraft {
  return { type: "profile_property", field: "city", op: "IN", value: "" };
}

export function newBehaviorCondition(event = ""): BehaviorConditionDraft {
  return { type: "behavior", event, measure: "COUNT", attribute: "", windowValue: "7", windowUnit: "DAYS", op: ">=", value: "1", filters: [] };
}

export function emptySegmentDraft(): SegmentDraft {
  return { id: newSegmentId(), create: true, name: "", description: "", groups: [[newProfileCondition()]] };
}

function valueText(value: string | number | string[]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function conditionDraft(condition: SegmentCondition): ConditionDraft {
  if (condition.type === "profile_property") {
    return { type: "profile_property", field: condition.field, op: condition.op, value: valueText(condition.value) };
  }
  return {
    type: "behavior",
    event: condition.event,
    measure: condition.measure,
    attribute: condition.attribute ?? "",
    windowValue: String(condition.window.value),
    windowUnit: condition.window.unit,
    op: condition.op,
    value: String(condition.value),
    ...filterDrafts(condition.filters),
  };
}

// Filters the editor can show are one condition per group (all must pass). Anything else is kept
// as stored, so an edit never rewrites a rule the page can't display.
function filterDrafts(filters: BehaviorCondition["filters"]): Pick<BehaviorConditionDraft, "filters" | "keptFilters"> {
  const groups = filters?.groups ?? [];
  if (groups.some((group) => group.conditions.length !== 1)) return { filters: [], keptFilters: filters };
  return {
    filters: groups.map(({ conditions: [filter] }) => ({ field: filter.field, op: filter.op, value: valueText(filter.value) })),
  };
}

export function segmentDraft(segment: Segment): SegmentDraft {
  return {
    id: segment.id,
    create: false,
    name: segment.name,
    description: segment.description,
    groups: segment.conditions.groups.map((group) => group.conditions.map(conditionDraft)),
  };
}

// Text that reads as a number becomes one. Anything else stays text, for the server to refuse
// with the place it is in.
function numberOrText(text: string): number | string {
  const trimmed = text.trim();
  return trimmed !== "" && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
}

function propertyValue(draft: { op: PropertyOperator; value: string }): string | number | string[] {
  if (draft.op === "IN") return draft.value.split(",").map((item) => item.trim()).filter(Boolean);
  if (draft.op === "LIKE" || draft.op === "=" || draft.op === "!=") return draft.value.trim();
  return numberOrText(draft.value);
}

// The segment as the save action takes it. The server parses it again and names what is wrong.
export function segmentInput(draft: SegmentDraft) {
  return {
    id: draft.id,
    create: draft.create,
    name: draft.name,
    description: draft.description,
    conditions: {
      groups: draft.groups.map((conditions) => ({
        conditions: conditions.map((condition) =>
          condition.type === "profile_property"
            ? { type: condition.type, field: condition.field, op: condition.op, value: propertyValue(condition) }
            : {
              type: condition.type,
              event: condition.event,
              measure: condition.measure,
              ...(condition.attribute.trim() ? { attribute: condition.attribute.trim() } : {}),
              ...savedFilters(condition),
              window: { value: numberOrText(condition.windowValue), unit: condition.windowUnit },
              op: condition.op,
              value: numberOrText(condition.value),
            }),
      })),
    },
  };
}

function savedFilters(draft: BehaviorConditionDraft): { filters?: BehaviorCondition["filters"] } {
  if (draft.keptFilters) return { filters: draft.keptFilters };
  if (draft.filters.length === 0) return {};
  return {
    filters: {
      groups: draft.filters.map((filter) => ({
        conditions: [{ type: "event_property" as const, field: filter.field, op: filter.op, value: propertyValue(filter) }],
      })),
    },
  };
}

// The measures the segment editor offers, in plain words with the system name beside (the board's
// order). A stored condition with another measure keeps it and shows its system name.
export const MEASURE_LABELS = {
  COUNT: "Number of times",
  SUM: "Total of a field",
  AVG: "Average of a field",
  MIN: "Lowest value of a field",
  MAX: "Highest value of a field",
  MEDIAN: "Median of a field",
  DISTINCT_COUNT: "Number of different values",
} as const satisfies Partial<Record<MetricAggregationFunction, string>>;

export const OFFERED_MEASURES = Object.keys(MEASURE_LABELS) as (keyof typeof MEASURE_LABELS)[];

export function measureLabel(measure: MetricAggregationFunction): string {
  return measure in MEASURE_LABELS ? MEASURE_LABELS[measure as keyof typeof MEASURE_LABELS] : measure;
}

export type DraftField =
  | "name" | "value" | "event" | "attribute" | "threshold" | "window" | "filter-field" | "filter-value";

/** Where a save is refused before it leaves the page, and the message the page shows. */
export interface DraftProblem {
  /** 0-based; null for the name. */
  group: number | null;
  condition: number | null;
  field: DraftField;
  /** 0-based; set when the gap is in one of the condition's filters. */
  filter?: number;
  message: string;
}

const KEPT = "Fill it in, or remove the condition. Nothing you typed was lost.";
const FILTER_KEPT = "Fill it in, or remove the filter. Nothing you typed was lost.";

function isNumberText(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text.trim()));
}

type Gap = { field: DraftField; needs: string; filter?: number };

function conditionGap(condition: ConditionDraft): Gap | null {
  if (condition.type === "profile_property") {
    return condition.value.trim() === "" ? { field: "value", needs: "a value" } : null;
  }
  if (!condition.event) return { field: "event", needs: "an event" };
  if (measureReadsAttribute(condition.measure) && !condition.attribute.trim()) {
    return { field: "attribute", needs: "a field to measure" };
  }
  if (!isNumberText(condition.value)) {
    return { field: "threshold", needs: condition.measure === "COUNT" ? "a number of times" : "a threshold" };
  }
  if (!isNumberText(condition.windowValue) || Number(condition.windowValue) <= 0) {
    return { field: "window", needs: "a time window above 0" };
  }
  for (const [f, filter] of condition.filters.entries()) {
    if (!filter.field) return { field: "filter-field", needs: "a field", filter: f };
    if (!filter.value.trim()) return { field: "filter-value", needs: "a value", filter: f };
  }
  return null;
}

// SEG-FR-43: the first gap that would break SEG-FR-03, named by group and condition, so the page
// marks the field and keeps every typed value. The server parses again and stays the authority.
export function firstProblem(draft: SegmentDraft): DraftProblem | null {
  if (!draft.name.trim()) {
    return { group: null, condition: null, field: "name", message: "The segment needs a name. Nothing you typed was lost." };
  }
  for (const [g, group] of draft.groups.entries()) {
    for (const [c, condition] of group.entries()) {
      const gap = conditionGap(condition);
      if (gap?.filter !== undefined) {
        return {
          group: g, condition: c, field: gap.field, filter: gap.filter,
          message: `Group ${g + 1}, condition ${c + 1}, filter ${gap.filter + 1} needs ${gap.needs}. ${FILTER_KEPT}`,
        };
      }
      if (gap) {
        return { group: g, condition: c, field: gap.field, message: `Group ${g + 1}, condition ${c + 1} needs ${gap.needs}. ${KEPT}` };
      }
    }
  }
  return null;
}
