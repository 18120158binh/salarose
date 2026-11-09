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
  /** Filters of a stored condition. The editor keeps them as they are. */
  filters?: BehaviorCondition["filters"];
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
  return { type: "behavior", event, measure: "COUNT", attribute: "", windowValue: "7", windowUnit: "DAYS", op: ">=", value: "1" };
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
    ...(condition.filters ? { filters: condition.filters } : {}),
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

function profileValue(draft: ProfileConditionDraft): string | number | string[] {
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
            ? { type: condition.type, field: condition.field, op: condition.op, value: profileValue(condition) }
            : {
              type: condition.type,
              event: condition.event,
              measure: condition.measure,
              ...(condition.attribute.trim() ? { attribute: condition.attribute.trim() } : {}),
              ...(condition.filters ? { filters: condition.filters } : {}),
              window: { value: numberOrText(condition.windowValue), unit: condition.windowUnit },
              op: condition.op,
              value: numberOrText(condition.value),
            }),
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

export type DraftField = "name" | "value" | "event" | "attribute" | "threshold" | "window";

/** Where a save is refused before it leaves the page, and the message the page shows. */
export interface DraftProblem {
  /** 0-based; null for the name. */
  group: number | null;
  condition: number | null;
  field: DraftField;
  message: string;
}

const KEPT = "Fill it in, or remove the condition. Nothing you typed was lost.";

function isNumberText(text: string): boolean {
  return text.trim() !== "" && Number.isFinite(Number(text.trim()));
}

function conditionGap(condition: ConditionDraft): { field: DraftField; needs: string } | null {
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
      if (gap) {
        return { group: g, condition: c, field: gap.field, message: `Group ${g + 1}, condition ${c + 1} needs ${gap.needs}. ${KEPT}` };
      }
    }
  }
  return null;
}
