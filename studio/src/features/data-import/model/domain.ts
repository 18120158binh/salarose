// The data import domain as studio sees it (docs/internal/features/data-import.md). Each union
// matches a CHECK constraint of infra/db/migrations/V0004__data_import_tables.sql.

export const DATASET_KINDS = ["profile", "event"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

export const COLUMN_TYPES = ["string", "number", "boolean", "datetime", "json"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const DELIVERY_MODES = ["incremental", "snapshot"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const DELIMITERS = [",", ";"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export interface DatasetColumn {
  name: string;
  displayName: string;
  type: ColumnType;
  pii: boolean;
  aliases: string[];
}

/** Roles that map to one column. Email and phone map to a list. */
export const SINGLE_ROLES = ["customer_key", "record_id", "event_time", "updated_at", "deleted_flag"] as const;
export type SingleRole = (typeof SINGLE_ROLES)[number];
export const LIST_ROLES = ["email", "phone"] as const;
export type ListRole = (typeof LIST_ROLES)[number];
export type Role = SingleRole | ListRole;

/** Stored as `import_record_type_versions.roles`: a column name per role. */
export type DatasetRoles = Partial<Record<SingleRole, string>> & Partial<Record<ListRole, string[]>>;

export type RoleRule = "required" | "optional" | "absent";

/** DIM-FR-03: which roles each kind has. Email and phone are repeatable where they are optional. */
export const ROLE_RULES: Record<DatasetKind, Record<Role, RoleRule>> = {
  profile: {
    customer_key: "required",
    record_id: "absent",
    event_time: "absent",
    updated_at: "optional",
    deleted_flag: "optional",
    email: "optional",
    phone: "optional",
  },
  event: {
    customer_key: "required",
    record_id: "required",
    event_time: "required",
    updated_at: "optional",
    deleted_flag: "optional",
    email: "absent",
    phone: "absent",
  },
};

export const ROLE_LABELS: Record<Role, string> = {
  customer_key: "Customer key",
  record_id: "Record id",
  event_time: "Event time",
  updated_at: "Updated at",
  deleted_flag: "Deleted flag",
  email: "Email",
  phone: "Phone",
};

/** One immutable row of `import_record_type_versions`, without its keys and timestamps. */
export interface DatasetVersion {
  columns: DatasetColumn[];
  roles: DatasetRoles;
  deliveryMode: DeliveryMode;
  timeZone: string;
  delimiter: Delimiter;
}

export const RUN_SOURCES = ["api", "drop", "studio", "rederive"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

export const RUN_STATES = [
  "uploading",
  "queued",
  "validating",
  "quarantined",
  "approved",
  "discarded",
  "applying",
  "applied",
  "failed",
  "expired",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** The status tones of the Salarose status pill: icon plus label, never color alone. */
export type StatusTone = "ok" | "warn" | "bad" | "info" | "off";

/**
 * The Imports board's run labels. The board draws Applied, Held for review, Failed, Waiting to
 * apply, Discarded, and Expired. It draws no label for the four transient states, so they read
 * as what the run is doing.
 */
export const RUN_STATE_LABELS: Record<RunState, { label: string; tone: StatusTone }> = {
  uploading: { label: "Uploading", tone: "info" },
  queued: { label: "Waiting to apply", tone: "info" },
  validating: { label: "Checking", tone: "info" },
  quarantined: { label: "Held for review", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  discarded: { label: "Discarded", tone: "off" },
  applying: { label: "Applying", tone: "info" },
  applied: { label: "Applied", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  expired: { label: "Expired", tone: "off" },
};

export const PASS_STATES = ["running", "done", "failed"] as const;
export type PassState = (typeof PASS_STATES)[number];

/** A failed pass is "Stopped" on the board. */
export const PASS_STATE_LABELS: Record<PassState, { label: string; tone: StatusTone }> = {
  running: { label: "Running", tone: "info" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Stopped", tone: "bad" },
};

export const METRIC_FUNCTIONS = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "MEDIAN",
  "DISTINCT_COUNT",
  "LATEST",
  "FIRST_TIME",
  "LAST_TIME",
] as const;
export type MetricFunction = (typeof METRIC_FUNCTIONS)[number];

/** What column each function takes: none, a `number` column, or any column. */
export const METRIC_FUNCTION_COLUMN: Record<MetricFunction, "none" | "number" | "any"> = {
  COUNT: "none",
  SUM: "number",
  AVG: "number",
  MIN: "number",
  MAX: "number",
  MEDIAN: "number",
  DISTINCT_COUNT: "any",
  LATEST: "any",
  FIRST_TIME: "none",
  LAST_TIME: "none",
};

export const PII_ACTIONS = ["reveal", "rejects_download", "deletion_request"] as const;
export type PiiAction = (typeof PII_ACTIONS)[number];

export const TOMBSTONE_STATES = ["requested", "done"] as const;
export type TombstoneState = (typeof TOMBSTONE_STATES)[number];

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
