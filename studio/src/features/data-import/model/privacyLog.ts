import type { SqlQuery } from "@/lib/db";
import { isOneOf, PII_ACTIONS, RUN_SOURCES, TOMBSTONE_STATES, type PiiAction, type TombstoneState } from "./domain";
import { fileName, instant } from "./imports";

// /data/privacy (DIM-FR-22, DIM-FR-23, DIM-FR-28): the deletion requests and the access log. Neither
// read returns a clear PII value. A deletion request shows only its tombstone, shortened.

export const ACCESS_LOG_PAGE_SIZE = 50;
export const REQUESTS_SHOWN = 50;
export const MAX_CUSTOMER_KEY_LENGTH = 256;

export const LOG_FILTERS = ["all", ...PII_ACTIONS] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];

export const PII_ACTION_LABELS: Record<PiiAction, string> = {
  reveal: "Revealed a value",
  rejects_download: "Downloaded rejected rows",
  deletion_request: "Requested a deletion",
};

export const TOMBSTONE_STATE_LABELS: Record<TombstoneState, string> = {
  requested: "Requested",
  done: "Done",
};

export function parseLogFilter(value: string | string[] | undefined): LogFilter {
  const single = Array.isArray(value) ? value[0] : value;
  return isOneOf(LOG_FILTERS, single) ? single : "all";
}

/** "7f3a…c21": enough to tell two requests apart, never the key. */
export function shortCode(tombstone: string): string {
  return `${tombstone.slice(0, 4)}…${tombstone.slice(-3)}`;
}

export interface DeletionRequestRow {
  tombstone: string;
  requestedBy: string | null;
  requestedAt: number;
  state: TombstoneState;
}

/** What a log row names: a customer key, a hidden person, or a run's file. */
export type LogSubject =
  | { kind: "customer"; customerKey: string }
  | { kind: "hidden"; code: string | null }
  | { kind: "file"; name: string }
  | { kind: "none" };

export interface AccessLogRow {
  id: string;
  at: number;
  who: string;
  action: PiiAction;
  subject: LogSubject;
  fields: string[];
  route: string;
}

export const REQUESTS_QUERY: SqlQuery = {
  text: `SELECT t.customer_key_hash, t.requested_at, t.state, u.email AS requested_by
         FROM person_tombstones t LEFT JOIN system_users u ON u.id = t.requested_by
         ORDER BY t.requested_at DESC LIMIT ${REQUESTS_SHOWN}`,
  values: [],
};

export function parseRequest(row: Record<string, unknown>): DeletionRequestRow | null {
  const requestedAt = instant(row.requested_at);
  if (typeof row.customer_key_hash !== "string" || requestedAt === null || !isOneOf(TOMBSTONE_STATES, row.state)) return null;
  return {
    tombstone: row.customer_key_hash,
    requestedBy: typeof row.requested_by === "string" ? row.requested_by : null,
    requestedAt,
    state: row.state,
  };
}

export function accessLogQuery(filter: LogFilter): SqlQuery {
  return {
    text: `SELECT l.id, l.at, l.action, l.route, l.customer_key, l.customer_key_hash, l.fields, l.staff_id,
                  u.email AS staff_email, r.file_key, r.source AS run_source
           FROM pii_access_log l
           LEFT JOIN system_users u ON u.id = l.staff_id
           LEFT JOIN import_runs r ON r.id = l.run_id
           WHERE ($1::text IS NULL OR l.action = $1::text)
           ORDER BY l.at DESC, l.id
           LIMIT ${ACCESS_LOG_PAGE_SIZE}`,
    values: [filter === "all" ? null : filter],
  };
}

export const LOG_COUNTS_QUERY: SqlQuery = {
  text: `SELECT action, count(*)::int AS n FROM pii_access_log GROUP BY action`,
  values: [],
};

export function parseLogCounts(rows: Record<string, unknown>[]): Record<LogFilter, number> {
  const counts: Record<LogFilter, number> = { all: 0, reveal: 0, rejects_download: 0, deletion_request: 0 };
  for (const row of rows) {
    if (!isOneOf(PII_ACTIONS, row.action) || typeof row.n !== "number") continue;
    counts[row.action] = row.n;
    counts.all += row.n;
  }
  return counts;
}

function subjectOf(row: Record<string, unknown>, action: PiiAction): LogSubject {
  switch (action) {
    case "reveal":
      // DIM-FR-28: once a person is deleted the row holds the tombstone, and the page hides it.
      return typeof row.customer_key === "string"
        ? { kind: "customer", customerKey: row.customer_key }
        : { kind: "hidden", code: null };
    case "deletion_request":
      return { kind: "hidden", code: typeof row.customer_key_hash === "string" ? shortCode(row.customer_key_hash) : null };
    case "rejects_download":
      return isOneOf(RUN_SOURCES, row.run_source)
        ? { kind: "file", name: fileName({ fileKey: typeof row.file_key === "string" ? row.file_key : null, source: row.run_source }) }
        : { kind: "none" };
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

export function parseLogRow(row: Record<string, unknown>): AccessLogRow | null {
  const at = instant(row.at);
  if (typeof row.id !== "string" || at === null || !isOneOf(PII_ACTIONS, row.action)) return null;
  return {
    id: row.id,
    at,
    who: typeof row.staff_email === "string" ? row.staff_email : typeof row.staff_id === "string" ? row.staff_id : "Unknown",
    action: row.action,
    subject: subjectOf(row, row.action),
    fields: Array.isArray(row.fields) ? row.fields.filter((field): field is string => typeof field === "string") : [],
    route: typeof row.route === "string" ? row.route : "",
  };
}

/** The key a form sends, exactly as the datasets send it (IAP-FR-07): not trimmed, not empty, not huge. */
export function parseCustomerKey(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_CUSTOMER_KEY_LENGTH ? value : null;
}
