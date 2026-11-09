import { METRIC_DEFINITION_FUNCTIONS, isMetricFunction, type MetricAggregationFunction } from "./metricDefinitions";
import { UserFacingError } from "./userFacingError";

// The profile fields a segment condition can test, as the journey builder offers them.
export const SEGMENT_PROFILE_FIELDS = ["gender", "age", "city", "user_time"] as const;
export type SegmentProfileField = (typeof SEGMENT_PROFILE_FIELDS)[number];

export const PROPERTY_OPERATORS = [">", ">=", "<", "<=", "=", "!=", "LIKE", "IN"] as const;
export type PropertyOperator = (typeof PROPERTY_OPERATORS)[number];

export const BEHAVIOR_OPERATORS = [">", ">=", "<", "<=", "=", "!="] as const;
export type BehaviorOperator = (typeof BEHAVIOR_OPERATORS)[number];

export const WINDOW_UNITS = ["SECONDS", "MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"] as const;
export type WindowUnit = (typeof WINDOW_UNITS)[number];

// The measures that count occurrences and read no attribute.
const COUNTING_MEASURES: readonly MetricAggregationFunction[] = ["COUNT", "INACTION"];

export function measureReadsAttribute(measure: MetricAggregationFunction): boolean {
  return !COUNTING_MEASURES.includes(measure);
}

export interface EventPropertyCondition {
  type: "event_property";
  field: string;
  op: PropertyOperator;
  value: string | number | string[];
}

export interface ProfilePropertyCondition {
  type: "profile_property";
  field: SegmentProfileField;
  op: PropertyOperator;
  value: string | number | string[];
}

export interface BehaviorCondition {
  type: "behavior";
  event: string;
  measure: MetricAggregationFunction;
  attribute?: string;
  filters?: { groups: { conditions: EventPropertyCondition[] }[] };
  window: { value: number; unit: WindowUnit };
  op: BehaviorOperator;
  value: number;
  /** Written by the save, never by the marketer. */
  metric_id?: string;
}

export type SegmentCondition = ProfilePropertyCondition | BehaviorCondition;

export interface SegmentConditions {
  groups: { conditions: SegmentCondition[] }[];
}

export interface SegmentInput {
  /** The editor makes a new segment's id when it opens, so a retried create writes one row. */
  id?: SegmentId;
  /** True when the id names a segment to create, not one to edit. */
  create: boolean;
  name: string;
  description: string;
  conditions: SegmentConditions;
}

declare const segmentIdBrand: unique symbol;
export type SegmentId = string & { readonly [segmentIdBrand]: true };

const SEGMENT_ID_PATTERN = /^SEG-[0-9a-fA-F]{16}$/;

export function parseSegmentId(value: unknown): SegmentId {
  if (typeof value !== "string" || !SEGMENT_ID_PATTERN.test(value)) {
    throw new UserFacingError("A segment id is SEG- followed by 16 hexadecimal digits.");
  }
  return value as SegmentId;
}

// SEG-FR-02: SEG- and 64 random bits in hex.
export function newSegmentId(): SegmentId {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `SEG-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as SegmentId;
}

// How a campaign uses a segment: its entry trigger, the audience of a business-event trigger, or a
// segment_membership condition.
export const SEGMENT_USE_KINDS = ["entry_trigger", "event_audience", "condition"] as const;
export type SegmentUseKind = (typeof SEGMENT_USE_KINDS)[number];

// A segment counts as used only by active and paused campaigns, since drafts are not stored.
const USING_CAMPAIGN_STATUSES = ["active", "paused"] as const;
export type UsingCampaignStatus = (typeof USING_CAMPAIGN_STATUSES)[number];

export function parseUsingCampaignStatus(value: unknown): UsingCampaignStatus | null {
  return USING_CAMPAIGN_STATUSES.find((status) => status === value) ?? null;
}

// A campaign that uses a segment, as the page names it, with each way it uses it in
// SEGMENT_USE_KINDS order.
export interface SegmentUse {
  campaignId: string;
  campaignName: string;
  status: UsingCampaignStatus;
  kinds: SegmentUseKind[];
  /** The campaign's creator, or null when that user was deleted. */
  ownerId: string | null;
}

export interface Segment {
  id: SegmentId;
  name: string;
  description: string;
  conditions: SegmentConditions;
  updatedAt: string | null;
  /** The active and paused campaigns that use the segment. */
  usedBy: SegmentUse[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(place: string, message: string): never {
  throw new UserFacingError(`${place}: ${message}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePropertyComparison(raw: Record<string, unknown>, place: string) {
  const op = raw.op;
  if (typeof op !== "string" || !(PROPERTY_OPERATORS as readonly string[]).includes(op)) {
    fail(place, `the operator must be one of ${PROPERTY_OPERATORS.join(", ")}.`);
  }
  const value = raw.value;
  if (op === "IN") {
    if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.trim())) {
      fail(place, "IN needs a list of at least one value.");
    }
    return { op: op as PropertyOperator, value: value.map((item: string) => item.trim()) };
  }
  if (isFiniteNumber(value)) return { op: op as PropertyOperator, value };
  if (typeof value !== "string" || !value.trim()) fail(place, "the value is required.");
  if (op === "LIKE" && /^%*$/.test(value.trim())) fail(place, "LIKE needs text besides %.");
  return { op: op as PropertyOperator, value: value.trim() };
}

function parseEventPropertyCondition(raw: unknown, place: string): EventPropertyCondition {
  if (!isRecord(raw) || raw.type !== "event_property") fail(place, "a filter must be an event_property.");
  const field = typeof raw.field === "string" ? raw.field.trim() : "";
  if (!field) fail(place, "the filter needs an attribute.");
  return { type: "event_property", field, ...parsePropertyComparison(raw, place) };
}

function parseFilters(raw: unknown, place: string): BehaviorCondition["filters"] {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw) || !Array.isArray(raw.groups)) fail(place, "filters must be a list of groups.");
  if (raw.groups.length === 0) return undefined;
  return {
    groups: raw.groups.map((group: unknown, groupIndex: number) => {
      const groupPlace = `${place}, filter group ${groupIndex + 1}`;
      if (!isRecord(group) || !Array.isArray(group.conditions) || group.conditions.length === 0) {
        fail(groupPlace, "a group must hold at least one filter.");
      }
      return {
        conditions: group.conditions.map((condition: unknown, index: number) =>
          parseEventPropertyCondition(condition, `${groupPlace}, filter ${index + 1}`)),
      };
    }),
  };
}

export function parseBehaviorCondition(raw: Record<string, unknown>, place: string): BehaviorCondition {
  const event = typeof raw.event === "string" ? raw.event.trim() : "";
  if (!event) fail(place, "a behavior condition needs an event.");
  const measure = typeof raw.measure === "string" ? raw.measure.trim().toUpperCase() : "";
  if (!isMetricFunction(measure)) {
    fail(place, `the measure must be one of ${METRIC_DEFINITION_FUNCTIONS.join(", ")}.`);
  }
  const attribute = typeof raw.attribute === "string" ? raw.attribute.trim() : "";
  if (measureReadsAttribute(measure) && !attribute) fail(place, `${measure} needs an attribute.`);
  if (!measureReadsAttribute(measure) && attribute) fail(place, `${measure} reads no attribute.`);
  const window = raw.window;
  if (
    !isRecord(window)
    || !isFiniteNumber(window.value)
    || window.value <= 0
    || typeof window.unit !== "string"
    || !(WINDOW_UNITS as readonly string[]).includes(window.unit)
  ) {
    fail(place, `the window must be a number above 0 in ${WINDOW_UNITS.join(", ")}.`);
  }
  if (typeof raw.op !== "string" || !(BEHAVIOR_OPERATORS as readonly string[]).includes(raw.op)) {
    fail(place, `the operator must be one of ${BEHAVIOR_OPERATORS.join(", ")}.`);
  }
  if (!isFiniteNumber(raw.value)) fail(place, "the threshold must be a number.");
  const filters = parseFilters(raw.filters, place);
  return {
    type: "behavior",
    event,
    measure,
    ...(attribute ? { attribute } : {}),
    ...(filters ? { filters } : {}),
    window: { value: window.value, unit: window.unit as WindowUnit },
    op: raw.op as BehaviorOperator,
    value: raw.value,
    ...(typeof raw.metric_id === "string" && raw.metric_id ? { metric_id: raw.metric_id } : {}),
  };
}

function parseSegmentCondition(raw: unknown, place: string): SegmentCondition {
  if (!isRecord(raw)) fail(place, "a condition must be an object.");
  switch (raw.type) {
    case "profile_property": {
      const field = raw.field;
      if (typeof field !== "string" || !(SEGMENT_PROFILE_FIELDS as readonly string[]).includes(field)) {
        fail(place, `the profile field must be one of ${SEGMENT_PROFILE_FIELDS.join(", ")}.`);
      }
      return { type: "profile_property", field: field as SegmentProfileField, ...parsePropertyComparison(raw, place) };
    }
    case "behavior":
      return parseBehaviorCondition(raw, place);
    case "segment_membership":
      fail(place, "a segment cannot contain a segment_membership condition.");
    default:
      fail(place, "a condition must be profile_property or behavior.");
  }
}

// SEG-FR-03: at least one group, no empty group, only profile_property and behavior conditions.
// A refusal names the group and the condition.
export function parseSegmentConditions(raw: unknown): SegmentConditions {
  if (!isRecord(raw) || !Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new UserFacingError("A segment needs at least one group of conditions.");
  }
  return {
    groups: raw.groups.map((group: unknown, groupIndex: number) => {
      const place = `Group ${groupIndex + 1}`;
      if (!isRecord(group) || !Array.isArray(group.conditions) || group.conditions.length === 0) {
        fail(place, "a group must hold at least one condition.");
      }
      return {
        conditions: group.conditions.map((condition: unknown, index: number) =>
          parseSegmentCondition(condition, `${place}, condition ${index + 1}`)),
      };
    }),
  };
}

export function parseSegmentInput(raw: unknown): SegmentInput {
  if (!isRecord(raw)) throw new UserFacingError("A segment must be an object.");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new UserFacingError("A segment needs a name.");
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const create = raw.create === true;
  if (create && (raw.id === undefined || raw.id === null)) throw new UserFacingError("A new segment needs its id.");
  return {
    create,
    ...(raw.id === undefined || raw.id === null ? {} : { id: parseSegmentId(raw.id) }),
    name,
    description,
    conditions: parseSegmentConditions(raw.conditions),
  };
}

// The kind of use a JSON object of a node row records, if it names a segment.
function useKindOf(json: Record<string, unknown>): SegmentUseKind | null {
  if (json.kind === "segment_entry") return "entry_trigger";
  if (json.type === "segment") return "event_audience";
  if (json.type === "segment_membership") return "condition";
  return null;
}

// Where a campaign node uses a segment: a segment_entry trigger, a segment audience of a
// business_event trigger, or a segment_membership condition. Every nested object is searched, so a
// use is found wherever the node keeps its trigger or conditions.
function collectSegmentUses(json: unknown, found: Map<string, Set<SegmentUseKind>>): void {
  if (Array.isArray(json)) {
    json.forEach((item) => collectSegmentUses(item, found));
    return;
  }
  if (!isRecord(json)) return;
  const kind = useKindOf(json);
  if (kind && typeof json.segment_id === "string") {
    found.set(json.segment_id, (found.get(json.segment_id) ?? new Set()).add(kind));
  }
  Object.values(json).forEach((value) => collectSegmentUses(value, found));
}

// The segments that one node row's JSON columns use, each with its kinds of use. A column that
// does not parse uses none.
export function segmentUsesOfNodeRow(columns: (string | null | undefined)[]): Map<string, Set<SegmentUseKind>> {
  const found = new Map<string, Set<SegmentUseKind>>();
  for (const column of columns) {
    if (!column) continue;
    try {
      collectSegmentUses(JSON.parse(column), found);
    } catch {
      continue;
    }
  }
  return found;
}

// The behavior conditions of a segment, in group order.
export function behaviorConditions(conditions: SegmentConditions): BehaviorCondition[] {
  return conditions.groups.flatMap((group) =>
    group.conditions.filter((condition): condition is BehaviorCondition => condition.type === "behavior"));
}
