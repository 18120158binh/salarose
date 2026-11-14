import type { PublishedCampaign } from "@/lib/db";
import { UserFacingError } from "shared/lib/userFacingError";
import {
  BEHAVIOR_OPERATORS,
  FIELD_OPERATORS,
  WINDOW_UNITS,
  type BehaviorCondition,
  type CampaignTreeNode,
  type CampaignTreeRef,
  type CheckBranch,
  type CheckNext,
  type CheckNode,
  type ConditionGroups,
  type DelayPath,
  type EngagementNode,
  type EventFilters,
  type EventPropertyCondition,
  type FieldOperator,
  type FieldValue,
  type NoPath,
  type PersonCondition,
  type PersonConditions,
  type ProfilePropertyCondition,
  type PushEngagement,
  type SegmentNext,
  type SegmentNode,
  type SetupNode,
  type SuccessOrTimeoutPath,
  type SuccessPath,
  type TimeoutPath,
  type WatchNext,
  type WatchNode,
  type YesOrNoPath,
  type YesPath,
} from "./types";
import { offersMeasure, offersTrigger, type RuntimeRegistry } from "./registry";

// Parses a campaign that the browser sends to publish, or a journey stored by an earlier publish.
// It checks the parts of the journey that decide the node rows: each node's type and id, the shape
// of its outcomes, and the tree as a whole. Filters and conditions must be lists of groups in the
// condition language of customer decision, with no empty group, and a behavior condition must
// have a number value and a window above 0 in a known unit. Customer decision skips a
// node row that breaks these. Publish checks each behavior condition's metric.
//
// One walk finds every problem. It skips only a part it cannot read, such as a node that is not
// an object or has an unknown type. Publish and the classic builder report the first problem
// found, which is the one an earlier build threw.

export interface JourneyProblem {
  severity: "blocking" | "warning";
  rule: "shape" | "runtime";
  /** The id of the nearest node that holds the problem, when that node has one. */
  nodeId: string | undefined;
  /** The path from that node, such as `eventName` or `filters.groups[0]`, or "" for the node itself. */
  field: string;
  /** The path from the root, such as `root.next[0].eventName`. */
  path: string;
  message: string;
}

type Fields = Record<string, unknown>;

// Deep enough for any journey drawn by hand, and far below the depth that overflows the stack.
const MAX_DEPTH = 200;
const TOO_DEEP = `nests nodes more than ${MAX_DEPTH} levels deep`;

// The parent_branch names of the fixed outcomes in the journey builder's saved format. A
// multi-branch key is written to parent_branch too, so it must not look like one of them.
const FIXED_BRANCHES = ["next", "yes", "no", "success", "timeout"];

// End node ids join the parent id, the branch key, and the child's position with "-", so a key
// with "-" in it could give two End nodes the same id.
const BRANCH_KEY = /^[A-Za-z0-9_]+$/;

const NODE_TYPES = ["setup", "check", "watch", "segment", "engagement", "end"] as const;

// What the whole walk shares: every problem in the order found, each with the place in tree order
// of the node being parsed when it was found, the node ids seen so far, the count of nodes
// entered, and the registry that runtime checks read, if any.
interface Tree {
  found: { place: number; problem: JourneyProblem }[];
  ids: Set<string>;
  nodes: number;
  registry: RuntimeRegistry | undefined;
}

// What a walk down the tree carries: the depth of the node being parsed, where the root is 1, its
// place in tree order, and the node that holds a problem found there.
interface Walk {
  tree: Tree;
  depth: number;
  place: number;
  owner: { id: string | undefined; path: string };
}

// A field is undefined only where the walk found a problem, and a tree with a shape problem is
// never returned, so no caller sees the hole.
type Holes<T> = { [K in keyof T]: T[K] | undefined };
const filled = <T>(value: Holes<T>): T => value as T;

type Kind = Pick<JourneyProblem, "severity" | "rule">;
const SHAPE: Kind = { severity: "blocking", rule: "shape" };

function problem(walk: Walk, path: string, message: string, kind = SHAPE): undefined {
  const { id, path: ownerPath } = walk.owner;
  walk.tree.found.push({
    place: walk.place,
    problem: {
      ...kind,
      nodeId: id,
      field: path.slice(ownerPath.length).replace(/^\./, ""),
      path,
      message,
    },
  });
  return undefined;
}

function record(value: unknown, path: string, walk: Walk): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return problem(walk, path, "must be an object");
  }
  return value as Fields;
}

function requiredString(fields: Fields, key: string, path: string, walk: Walk): string | undefined {
  const value = fields[key];
  if (typeof value !== "string") return problem(walk, `${path}.${key}`, "must be a string");
  return value;
}

function nonEmptyString(fields: Fields, key: string, path: string, walk: Walk): string | undefined {
  const value = requiredString(fields, key, path, walk);
  if (value?.trim() === "") return problem(walk, `${path}.${key}`, "must not be empty");
  return value;
}

function optionalString(fields: Fields, key: string, path: string, walk: Walk): string | undefined {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return problem(walk, `${path}.${key}`, "must be a string");
  return value;
}

function oneOf<T extends string>(fields: Fields, key: string, path: string, allowed: readonly T[], walk: Walk): T | undefined {
  const value = fields[key];
  const match = allowed.find((option) => option === value);
  if (match === undefined) return problem(walk, `${path}.${key}`, `must be one of ${allowed.join(", ")}`);
  return match;
}

function finiteNumber(fields: Fields, key: string, path: string, walk: Walk): number | undefined {
  const value = fields[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return problem(walk, `${path}.${key}`, "must be a number");
  return value;
}

function positiveNumber(fields: Fields, key: string, path: string, walk: Walk): number | undefined {
  const value = finiteNumber(fields, key, path, walk);
  if (value !== undefined && value <= 0) return problem(walk, `${path}.${key}`, "must be greater than 0");
  return value;
}

function claimId(id: string, path: string, walk: Walk): string {
  if (walk.tree.ids.has(id)) problem(walk, `${path}.id`, `must be unique, but ${id} is already used`);
  walk.tree.ids.add(id);
  return id;
}

function nodeId(fields: Fields, path: string, walk: Walk): string | undefined {
  const id = nonEmptyString(fields, "id", path, walk);
  return id === undefined ? undefined : claimId(id, path, walk);
}

// An End node may leave out its id. The node rows then name it by its place in the tree.
function endNodeId(fields: Fields, path: string, walk: Walk): string | undefined {
  const id = optionalString(fields, "id", path, walk);
  return id ? claimId(id, path, walk) : id;
}

// A LIKE pattern of only % matches every value. A "contains" with no text saves one.
const MATCH_ANYTHING = /^%+$/;

function isScalar(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function fieldValue(fields: Fields, op: FieldOperator, path: string, walk: Walk): FieldValue | undefined {
  const value = fields.value;
  if (op === "IN") {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) {
      return problem(walk, `${path}.value`, "must be a list of at least one string or number for IN");
    }
    return value;
  }
  if (!isScalar(value)) return problem(walk, `${path}.value`, "must be a string or a number");
  if (op === "LIKE" && typeof value === "string" && MATCH_ANYTHING.test(value)) {
    return problem(walk, `${path}.value`, "must have text to match, not only %");
  }
  return value;
}

function fieldCondition<T extends "event_property" | "profile_property">(fields: Fields, type: T, path: string, walk: Walk) {
  const op = oneOf(fields, "op", path, FIELD_OPERATORS, walk);
  return {
    type,
    field: nonEmptyString(fields, "field", path, walk),
    op,
    // Which values are valid depends on the operator.
    value: op === undefined ? undefined : fieldValue(fields, op, path, walk),
  };
}

function eventCondition(value: unknown, path: string, walk: Walk): EventPropertyCondition | undefined {
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  if (fields.type !== "event_property") return problem(walk, `${path}.type`, 'must be "event_property"');
  return filled<EventPropertyCondition>({
    ...fieldCondition(fields, "event_property", path, walk),
    ...(fields.isDefault === true ? { isDefault: true } : {}),
  });
}

function behaviorCondition(fields: Fields, path: string, walk: Walk): BehaviorCondition {
  const attribute = optionalString(fields, "attribute", path, walk);
  const metricId = optionalString(fields, "metric_id", path, walk);
  const filters = optionalGroups(fields, "filters", path, eventCondition, walk);
  const windowFields = record(fields.window, `${path}.window`, walk);
  const window = windowFields && filled<BehaviorCondition["window"]>({
    value: positiveNumber(windowFields, "value", `${path}.window`, walk),
    unit: oneOf(windowFields, "unit", `${path}.window`, WINDOW_UNITS, walk),
  });
  const condition = filled<BehaviorCondition>({
    type: "behavior",
    event: nonEmptyString(fields, "event", path, walk),
    measure: offeredMeasure(nonEmptyString(fields, "measure", path, walk), `${path}.measure`, walk),
    ...(attribute ? { attribute } : {}),
    ...(filters ? { filters } : {}),
    window,
    op: oneOf(fields, "op", path, BEHAVIOR_OPERATORS, walk),
    value: finiteNumber(fields, "value", path, walk),
    ...(metricId ? { metric_id: metricId } : {}),
  });
  zeroCount(condition, path, walk);
  return condition;
}

// A count is kept only for events that happen, so a count that must be 0 never matches (JBD-FR-44).
function zeroCount(condition: BehaviorCondition, path: string, walk: Walk): void {
  const { event, measure, op, value, window } = condition;
  if (!walk.tree.registry || !event || measure !== "COUNT" || typeof value !== "number" || !window) return;
  const onlyZero = op === "=" ? value === 0 : op === "<=" ? value < 1 : op === "<" ? value <= 1 : false;
  if (!onlyZero) return;
  const unit = window.unit.toLowerCase().replace(/s$/, "");
  const span = window.value === 1 ? unit : `${window.value} ${unit}s`;
  problem(walk, path,
    `"did ${event} 0 times in the last ${span}" never matches, because a count is only kept for events that happen. Replace or remove it`,
    { severity: "warning", rule: "runtime" });
}

function personCondition(value: unknown, path: string, walk: Walk): PersonCondition | undefined {
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  if (fields.type === "behavior") return behaviorCondition(fields, path, walk);
  if (fields.type === "profile_property") {
    return filled<ProfilePropertyCondition>(fieldCondition(fields, "profile_property", path, walk));
  }
  return problem(walk, `${path}.type`, 'must be "profile_property" or "behavior"');
}

// A list of groups. Every group must hold at least one condition.
function optionalGroups<C>(
  fields: Fields,
  key: string,
  path: string,
  condition: (value: unknown, path: string, walk: Walk) => C | undefined,
  walk: Walk,
): ConditionGroups<C> | undefined {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  const list = record(value, `${path}.${key}`, walk);
  if (list === undefined) return undefined;
  if (!Array.isArray(list.groups)) return problem(walk, `${path}.${key}.groups`, "must be an array");
  return {
    groups: list.groups.flatMap((item, index) => {
      const groupPath = `${path}.${key}.groups[${index}]`;
      const group = record(item, groupPath, walk);
      if (group === undefined) return [];
      if (!Array.isArray(group.conditions)) {
        problem(walk, `${groupPath}.conditions`, "must be an array");
        return [];
      }
      if (group.conditions.length === 0) problem(walk, groupPath, "must hold at least one condition");
      return [{ conditions: group.conditions.flatMap((entry, at) => condition(entry, `${groupPath}.conditions[${at}]`, walk) ?? []) }];
    }),
  };
}

function eventFilters(fields: Fields, path: string, walk: Walk): EventFilters | undefined {
  return optionalGroups(fields, "filters", path, eventCondition, walk);
}

function personConditions(fields: Fields, path: string, walk: Walk): PersonConditions | undefined {
  return optionalGroups(fields, "conditions", path, personCondition, walk);
}

// The event that a setup, a check, or a watch fires on. Customer decision skips a rule without one.
function triggerEvent(fields: Fields, key: string, path: string, id: string | undefined, walk: Walk): string | undefined {
  const value = fields[key];
  if (typeof value !== "string" || value.trim() === "") {
    return problem(walk, `${path}.${key}`, `must name the trigger event of ${id ?? path}`);
  }
  return value;
}

// A condition split has no trigger, so it fires only when a behavior condition's metric changes.
function segmentConditions(fields: Fields, path: string, id: string | undefined, walk: Walk): PersonConditions | undefined {
  const conditions = personConditions(fields, path, walk);
  const hasBehavior = conditions?.groups.some((group) => group.conditions.some((c) => c.type === "behavior"));
  if (!conditions || !hasBehavior) {
    return problem(walk, `${path}.conditions`, `must hold a behavior condition for the condition split ${id ?? path}`);
  }
  return conditions;
}

// Older builds also saved a fixed phone, which the outbox never sent. It is left out here, so a
// journey that still carries one loads and publishes without it.
function engagementAction(value: unknown, path: string, walk: Walk): PushEngagement | undefined {
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  return filled<PushEngagement>({
    type: nonEmptyString(fields, "type", path, walk),
    title: optionalString(fields, "title", path, walk),
    body: optionalString(fields, "body", path, walk),
    subject: optionalString(fields, "subject", path, walk),
    url: optionalString(fields, "url", path, walk),
    payload: fields.payload,
    templateId: optionalString(fields, "templateId", path, walk),
    method: optionalString(fields, "method", path, walk),
  });
}

// A saved trigger that the runtime does not run yet still loads. The builder shows it read-only,
// and it blocks publish (JBD-FR-31). A setup and a check save "business" for a business event.
function offeredTrigger<T extends string | undefined>(saved: T, path: string, walk: Walk): T {
  const kind = saved === "business" ? "business_event" : "event";
  if (walk.tree.registry && !offersTrigger(walk.tree.registry, kind)) {
    problem(walk, path, `uses the trigger kind ${kind}, which the runtime does not run yet`, { severity: "blocking", rule: "runtime" });
  }
  return saved;
}

function offeredMeasure(measure: string | undefined, path: string, walk: Walk): string | undefined {
  if (walk.tree.registry && measure !== undefined && !offersMeasure(measure)) {
    problem(walk, path, `is ${measure}, which the runtime never matches`, { severity: "warning", rule: "runtime" });
  }
  return measure;
}

// Reported once, for the tree as a whole, however many branches reach the limit.
function tooDeep(walk: Walk): undefined {
  if (walk.tree.found.some((found) => found.problem.message === TOO_DEEP)) return undefined;
  return problem({ ...walk, owner: { id: undefined, path: "root" } }, "root", TOO_DEEP);
}

// The children of the node at walk.depth, one level further down.
function treeRef(value: unknown, path: string, walk: Walk): CampaignTreeRef | undefined {
  const below = { ...walk, depth: walk.depth + 1 };
  if (below.depth > MAX_DEPTH) return tooDeep(walk);
  return Array.isArray(value)
    ? value.flatMap((item, index) => treeNode(item, `${path}[${index}]`, below) ?? [])
    : treeNode(value, path, below);
}

function branchKey(fields: Fields, path: string, keys: Set<string>, walk: Walk): string | undefined {
  const key = nonEmptyString(fields, "branchKey", path, walk);
  if (key === undefined) return undefined;
  if (FIXED_BRANCHES.includes(key)) return problem(walk, `${path}.branchKey`, "must not be next, yes, no, success, or timeout");
  if (!BRANCH_KEY.test(key)) return problem(walk, `${path}.branchKey`, "must contain only letters, digits, and underscores");
  if (keys.has(key)) return problem(walk, `${path}.branchKey`, `must be unique in its check, but ${key} is already used`);
  keys.add(key);
  return key;
}

function checkBranch(value: unknown, path: string, walk: Walk, keys: Set<string>): CheckBranch | undefined {
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  return filled<CheckBranch>({
    branchKey: branchKey(fields, path, keys, walk),
    priority: finiteNumber(fields, "priority", path, walk),
    label: optionalString(fields, "label", path, walk),
    filters: eventFilters(fields, path, walk),
    conditions: personConditions(fields, path, walk),
    next: treeRef(fields.next, `${path}.next`, walk),
  });
}

// The yes and no outcomes that a check and a segment share, or undefined for another type.
function yesNoNext(fields: Fields, path: string, walk: Walk): SegmentNext | undefined {
  switch (fields.type) {
    case "YesPath":
      return filled<YesPath>({ type: "YesPath", yes: treeRef(fields.yes, `${path}.yes`, walk) });
    case "NoPath":
      return filled<NoPath>({ type: "NoPath", no: treeRef(fields.no, `${path}.no`, walk) });
    case "YesOrNoPath":
      return filled<YesOrNoPath>({
        type: "YesOrNoPath",
        yes: treeRef(fields.yes, `${path}.yes`, walk),
        no: treeRef(fields.no, `${path}.no`, walk),
      });
    default:
      return undefined;
  }
}

function checkNext(value: unknown, path: string, walk: Walk): CheckNext | undefined {
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  if (fields.type === "MultiBranchPath") {
    if (!Array.isArray(fields.branches)) return problem(walk, `${path}.branches`, "must be an array");
    if (fields.branches.length === 0) return problem(walk, `${path}.branches`, "must not be empty");
    const keys = new Set<string>();
    return {
      type: "MultiBranchPath",
      branches: fields.branches.flatMap((branch, index) => checkBranch(branch, `${path}.branches[${index}]`, walk, keys) ?? []),
    };
  }
  return yesNoNext(fields, path, walk)
    ?? problem(walk, `${path}.type`, "must be YesPath, NoPath, YesOrNoPath, or MultiBranchPath");
}

// A segment has no named branches: the canvas cannot draw them for it.
function segmentNext(value: unknown, path: string, walk: Walk): SegmentNext | undefined {
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  return yesNoNext(fields, path, walk) ?? problem(walk, `${path}.type`, "must be YesPath, NoPath, or YesOrNoPath");
}

function watchNext(value: unknown, path: string, walk: Walk): WatchNext | undefined {
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  switch (fields.type) {
    case "SuccessPath":
      return filled<SuccessPath>({ type: "SuccessPath", success: treeRef(fields.success, `${path}.success`, walk) });
    case "TimeoutPath":
      return filled<TimeoutPath>({ type: "TimeoutPath", timeout: treeRef(fields.timeout, `${path}.timeout`, walk) });
    case "SuccessOrTimeoutPath":
      return filled<SuccessOrTimeoutPath>({
        type: "SuccessOrTimeoutPath",
        success: treeRef(fields.success, `${path}.success`, walk),
        timeout: treeRef(fields.timeout, `${path}.timeout`, walk),
      });
    case "DelayPath":
      return filled<DelayPath>({ type: "DelayPath", next: treeRef(fields.next, `${path}.next`, walk) });
    default:
      return problem(walk, `${path}.type`, "must be SuccessPath, TimeoutPath, SuccessOrTimeoutPath, or DelayPath");
  }
}

// A problem found before the node's type is known belongs to its parent.
function treeNode(value: unknown, path: string, parent: Walk): CampaignTreeNode | undefined {
  const walk = { ...parent, place: parent.tree.nodes++ };
  const fields = record(value, path, walk);
  if (fields === undefined) return undefined;
  const type = NODE_TYPES.find((known) => known === fields.type);
  if (type === undefined) return problem(walk, `${path}.type`, "must be setup, check, watch, segment, engagement, or end");
  const unnamed = { ...walk, owner: { id: undefined, path } };
  if (type === "setup" && walk.depth > 1) problem(unnamed, path, "must not be a setup node");
  const id = type === "end" ? endNodeId(fields, path, unnamed) : nodeId(fields, path, unnamed);
  const at = { ...walk, owner: { id, path } };
  switch (type) {
    case "setup":
      return filled<SetupNode>({
        type: "setup",
        id,
        label: requiredString(fields, "label", path, at),
        description: requiredString(fields, "description", path, at),
        triggerType: offeredTrigger(
          fields.triggerType === undefined ? undefined : oneOf(fields, "triggerType", path, ["user", "business"] as const, at),
          `${path}.triggerType`,
          at,
        ),
        triggerEventName: triggerEvent(fields, "triggerEventName", path, id, at),
        eventId: optionalString(fields, "eventId", path, at),
        filters: eventFilters(fields, path, at),
        conditions: personConditions(fields, path, at),
        next: treeRef(fields.next, `${path}.next`, at),
      });
    case "check":
      return filled<CheckNode>({
        type: "check",
        id,
        label: requiredString(fields, "label", path, at),
        eventType: offeredTrigger(optionalString(fields, "eventType", path, at), `${path}.eventType`, at),
        eventName: triggerEvent(fields, "eventName", path, id, at),
        eventId: optionalString(fields, "eventId", path, at),
        filters: eventFilters(fields, path, at),
        conditions: personConditions(fields, path, at),
        description: optionalString(fields, "description", path, at),
        next: checkNext(fields.next, `${path}.next`, at),
      });
    case "segment":
      return filled<SegmentNode>({
        type: "segment",
        id,
        label: requiredString(fields, "label", path, at),
        description: optionalString(fields, "description", path, at),
        conditions: segmentConditions(fields, path, id, at),
        next: segmentNext(fields.next, `${path}.next`, at),
      });
    case "watch": {
      const next = watchNext(fields.next, `${path}.next`, at);
      // A delay watches no event.
      const delay = next?.type === "DelayPath";
      return filled<WatchNode>({
        type: "watch",
        id,
        label: requiredString(fields, "label", path, at),
        eventName: delay ? optionalString(fields, "eventName", path, at) : triggerEvent(fields, "eventName", path, id, at),
        eventId: optionalString(fields, "eventId", path, at),
        filters: delay ? undefined : eventFilters(fields, path, at),
        conditions: delay ? undefined : personConditions(fields, path, at),
        timeLimitValue: positiveNumber(fields, "timeLimitValue", path, at),
        timeLimitUnit: oneOf(fields, "timeLimitUnit", path, ["seconds", "minutes", "hours", "days"] as const, at),
        description: optionalString(fields, "description", path, at),
        next,
      });
    }
    case "engagement":
      return filled<EngagementNode>({
        type: "engagement",
        id,
        label: requiredString(fields, "label", path, at),
        action: engagementAction(fields.action, `${path}.action`, at),
        next: treeRef(fields.next, `${path}.next`, at),
      });
    case "end":
      return {
        type: "end",
        id,
        goalId: optionalString(fields, "goalId", path, at),
      };
  }
}

function startWalk(registry?: RuntimeRegistry): Walk {
  return { tree: { found: [], ids: new Set(), nodes: 0, registry }, depth: 1, place: 0, owner: { id: undefined, path: "root" } };
}

// A journey is a tree under one setup node, the root.
function journeyRoot(value: unknown, walk: Walk): SetupNode | undefined {
  const fields = record(value, "root", walk);
  if (fields === undefined) return undefined;
  if (fields.type !== "setup") return problem(walk, "root.type", "must be setup");
  return treeNode(fields, "root", walk) as SetupNode | undefined;
}

// What the walk parsed, or the first problem it found, as the one error the classic builder shows.
function parsed<T>(walk: Walk, value: T | undefined): T {
  const first = walk.tree.found[0]?.problem;
  if (first !== undefined) throw new UserFacingError(`Invalid journey: ${first.path} ${first.message}.`);
  return value as T;
}

// Every problem in tree order: a node's own fields, then its children in order. The tree comes
// back only when it has no shape problem, as only then can publish write its node rows. With a
// registry, the walk also checks what the runtime runs, and a runtime problem keeps the tree.
export function validateJourney(
  value: unknown,
  registry?: RuntimeRegistry,
): { root: SetupNode | undefined; problems: JourneyProblem[] } {
  const walk = startWalk(registry);
  const root = journeyRoot(value, walk);
  const problems = walk.tree.found.sort((a, b) => a.place - b.place).map((found) => found.problem);
  return { root: problems.some((found) => found.rule === "shape") ? undefined : root, problems };
}

// The builder shows a node read-only while it uses a kind the runtime does not run yet.
export function readOnlyNodeIds(problems: readonly JourneyProblem[]): Set<string> {
  return new Set(problems.flatMap((found) =>
    found.rule === "runtime" && found.severity === "blocking" && found.nodeId !== undefined ? [found.nodeId] : []));
}

export function parseJourney(value: unknown): SetupNode {
  const walk = startWalk();
  return parsed(walk, journeyRoot(value, walk));
}

export function parseCampaignForPublish(value: unknown): PublishedCampaign {
  const walk = startWalk();
  const campaign = { ...walk, owner: { id: undefined, path: "campaign" } };
  const fields = record(value, "campaign", campaign) ?? {};
  return parsed(walk, filled<PublishedCampaign>({
    id: nonEmptyString(fields, "id", "campaign", campaign),
    name: nonEmptyString(fields, "name", "campaign", campaign),
    description: optionalString(fields, "description", "campaign", campaign) ?? "",
    root: journeyRoot(fields.root, walk),
  }));
}
