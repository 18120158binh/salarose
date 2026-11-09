export type NodeType = "setup" | "check" | "watch" | "segment" | "engagement" | "end";

// The engagement channels: an engagement node's sub type and its action type. The Java Channel
// enum in event-processor holds the same names.
export const CHANNELS = ["push", "sms", "email", "webhook", "web-push", "whatsapp", "facebook", "zalo"] as const;

export type Channel = (typeof CHANNELS)[number];

// The methods a webhook engagement can send with. The Java HttpMethod enum in event-processor holds
// the same names, and a webhook without a method sends POST.
export const WEBHOOK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type NodeSubType = "setup" | "check" | "watch" | "segment" | Channel | "custom-list";

export interface CampaignNode {
  id: string;
  type: NodeType;
  subType: NodeSubType;
  label: string;
  config: Record<string, any>;
  position: { x: number; y: number };
}

// The canvas edge kinds of the two binary paths. Yes, success, and a single next path use
// YES_EDGE. No and timeout use NO_EDGE. A multi-branch check's edges carry its branch keys instead.
export const YES_EDGE = "required";
export const NO_EDGE = "undefined";
export type BinaryEdgeKind = typeof YES_EDGE | typeof NO_EDGE;

export interface CampaignConnection {
  from: string;
  to: string;
  type: BinaryEdgeKind | (string & {});
}

// --- RULES ---
// A node's rule is a trigger and person conditions, in the shapes that campaign_nodes saves in
// trigger_json, conditions_json, and paths_json. See the saved format in
// docs/internal/features/journey-builder.md and the condition language in
// docs/internal/architecture/components/customer-decision.md.

export const FIELD_OPERATORS = [">", ">=", "<", "<=", "=", "!=", "LIKE", "IN"] as const;
export type FieldOperator = (typeof FIELD_OPERATORS)[number];

export const BEHAVIOR_OPERATORS = [">", ">=", "<", "<=", "=", "!="] as const;
export type BehaviorOperator = (typeof BEHAVIOR_OPERATORS)[number];

// The ordering operators, which compare numbers as numbers.
export const ORDERING_OPERATORS: readonly FieldOperator[] = [">", ">=", "<", "<="];

/** An IN value is a list. Any other value is one string or number. */
export type FieldScalar = string | number;
export type FieldValue = FieldScalar | FieldScalar[];

export interface EventPropertyCondition {
  type: "event_property";
  field: string;
  op: FieldOperator;
  value: FieldValue;
  /** Set in the tree on a catalog default row, which the marketer cannot edit. Never saved in a node row. */
  isDefault?: true;
}

export interface ProfilePropertyCondition {
  type: "profile_property";
  field: string;
  op: FieldOperator;
  value: FieldValue;
}

export const WINDOW_UNITS = ["SECONDS", "MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"] as const;
export type WindowUnit = (typeof WINDOW_UNITS)[number];

export const LIMIT_UNITS = ["SECONDS", "MINUTES", "HOURS", "DAYS"] as const;
export type LimitUnit = (typeof LIMIT_UNITS)[number];

export interface Duration<U extends string = WindowUnit> {
  value: number;
  unit: U;
}

/** A group passes when any of its conditions passes. It holds at least one. */
export interface ConditionGroup<C> {
  conditions: C[];
}

/** Every group must pass. */
export interface ConditionGroups<C> {
  groups: ConditionGroup<C>[];
}

export type EventFilters = ConditionGroups<EventPropertyCondition>;

export interface BehaviorCondition {
  type: "behavior";
  event: string;
  /** The metric function, such as COUNT or SUM. */
  measure: string;
  /** The attribute the measure reads. Absent for a measure that only counts events. */
  attribute?: string;
  filters?: EventFilters;
  window: Duration;
  op: BehaviorOperator;
  value: number;
  /** The metric definition the condition reads. Publish sets it. */
  metric_id?: string;
}

export type PersonCondition = ProfilePropertyCondition | BehaviorCondition;

export type PersonConditions = ConditionGroups<PersonCondition>;

export interface EventTrigger {
  kind: "event";
  event: string;
  filters?: EventFilters;
}

export type Trigger = EventTrigger;

export interface MultiBranchPathRow {
  key: string;
  filters?: EventFilters;
  conditions?: PersonConditions;
}

export type PathsRow =
  | { path_type: "SuccessOrTimeoutPath" | "SuccessPath" | "TimeoutPath" | "DelayPath"; limit: Duration<LimitUnit> }
  | { path_type: "MultiBranchPath"; branches: MultiBranchPathRow[] };

// --- TREE ADT DATA STRUCTURES ---

export interface PushEngagement {
  type: string;
  title?: string;
  body?: string;
  subject?: string;
  url?: string;
  payload?: any;
  templateId?: string;
  method?: string;
}

// Allow single node or array of nodes for parallel execution
export type CampaignTreeRef = CampaignTreeNode | CampaignTreeNode[];

export interface SetupNode {
  type: "setup";
  id: string;
  label: string;
  description: string;
  triggerType?: "user" | "business";
  triggerEventName: string;
  eventId?: string;
  filters?: EventFilters;
  conditions?: PersonConditions;
  next: CampaignTreeRef;
}

export interface EngagementNode {
  type: "engagement";
  id: string;
  label: string;
  action: PushEngagement;
  next: CampaignTreeRef;
}

export interface EndNode {
  type: "end";
  id?: string;
  goalId?: string;
}

// Check Node Outcomes
export interface YesPath {
  type: "YesPath";
  yes: CampaignTreeRef;
}

export interface NoPath {
  type: "NoPath";
  no: CampaignTreeRef;
}

export interface YesOrNoPath {
  type: "YesOrNoPath";
  yes: CampaignTreeRef;
  no: CampaignTreeRef;
}

export type CheckNext = YesPath | NoPath | YesOrNoPath | MultiBranchPath;

// Multi-branch fan-out: N branches each with their own condition
export interface CheckBranch {
  branchKey: string;      // "branch_0", "branch_1", "else"
  priority: number;
  label?: string;
  /** A branch with neither matches every event that passes the check. */
  filters?: EventFilters;
  conditions?: PersonConditions;
  next: CampaignTreeRef;
}

export interface MultiBranchPath {
  type: "MultiBranchPath";
  branches: CheckBranch[];
}

export interface CheckNode {
  type: "check";
  id: string;
  label: string;
  eventType?: string;
  eventName?: string;
  eventId?: string;
  filters?: EventFilters;
  conditions?: PersonConditions;
  description?: string;
  next: CheckNext;
}

// A segment has a check's yes and no paths, but no named branches.
export type SegmentNext = YesPath | NoPath | YesOrNoPath;

// Segment Node: the condition split. It has no trigger and fires yes when its conditions hold.
export interface SegmentNode {
  type: "segment";
  id: string;
  label: string;
  description?: string;
  /** Unset only while a draft is being edited. Publish requires a behavior condition. */
  conditions?: PersonConditions;
  next: SegmentNext;
}

// Watch Node Outcomes
export interface SuccessPath {
  type: "SuccessPath";
  success: CampaignTreeRef;
}

export interface TimeoutPath {
  type: "TimeoutPath";
  timeout: CampaignTreeRef;
}

export interface SuccessOrTimeoutPath {
  type: "SuccessOrTimeoutPath";
  success: CampaignTreeRef;
  timeout: CampaignTreeRef;
}

export type WatchNext = SuccessPath | TimeoutPath | SuccessOrTimeoutPath | DelayPath;

// Pure delay: wait X time then proceed, no condition
export interface DelayPath {
  type: "DelayPath";
  next: CampaignTreeRef;
}

export interface WatchNode {
  type: "watch";
  id: string;
  label: string;
  eventName?: string;
  eventId?: string;
  filters?: EventFilters;
  conditions?: PersonConditions;
  timeLimitValue: number;
  timeLimitUnit: "seconds" | "minutes" | "hours" | "days";
  description?: string;
  next: WatchNext;
}

export type CampaignTreeNode =
  | SetupNode
  | CheckNode
  | WatchNode
  | SegmentNode
  | EngagementNode
  | EndNode;

export interface Campaign {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft" | "paused";
  root: CampaignTreeNode; // The recursive root step
  created_at: string;
  updated_at: string;
  /** True for a published campaign with no owner. Only an admin's list shows one. */
  ownerless?: boolean;
}
