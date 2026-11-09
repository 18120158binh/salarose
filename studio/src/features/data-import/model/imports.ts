import type { SqlQuery } from "@/lib/db";
import { isOneOf, PASS_STATES, RUN_SOURCES, RUN_STATES, type PassState, type RunSource, type RunState } from "./domain";

// The rows of /data/imports (DIM-FR-20, DIM-FR-24): runs from import_runs and nightly passes from
// import_metric_passes, parsed once here so the page and its components trust the types.

export const RUNS_PAGE_SIZE = 50;
export const PASSES_SHOWN = 14;
const DAY_MS = 86_400_000;

/** The board's file filters. Waiting is a run at `queued`. */
export const RUN_FILTERS = ["all", "held", "failed", "waiting"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

export const RUN_FILTER_LABELS: Record<RunFilter, string> = {
  all: "All",
  held: "Held for review",
  failed: "Failed",
  waiting: "Waiting",
};

const FILTER_STATE: Record<Exclude<RunFilter, "all">, RunState> = {
  held: "quarantined",
  failed: "failed",
  waiting: "queued",
};

export interface RunQuery {
  filter: RunFilter;
  /** A dataset id, or null for every dataset. */
  dataset: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseRunQuery(params: Record<string, string | string[] | undefined>): RunQuery {
  const filter = single(params.state);
  const dataset = single(params.dataset);
  return { filter: isOneOf(RUN_FILTERS, filter) ? filter : "all", dataset: isUuid(dataset) ? dataset : null };
}

/** The counts the applier writes on a run. A key the run lacks reads as null, never 0. */
export interface RunCounts {
  rowsRead: number | null;
  rejected: number | null;
  rejectedByReason: { reason: string; count: number }[];
  /** The customer key match rate, 0 to 1 (DIM-FR-24). */
  matchRate: number | null;
  emailsDropped: number | null;
  phonesDropped: number | null;
}

export interface ImportRun {
  id: string;
  dataset: { id: string; displayName: string };
  version: number;
  source: RunSource;
  writer: string;
  format: string | null;
  byteSize: number | null;
  fileKey: string | null;
  state: RunState;
  reason: string | null;
  counts: RunCounts;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  approvedAt: number | null;
  /** The as_of of the first pass that included the run, or null before one did. */
  firstPassAsOf: number | null;
}

export interface MetricPass {
  id: string;
  asOf: number;
  state: PassState;
  reason: string | null;
  retryRequestedAt: number | null;
  changedRows: number | null;
  walBytes: number | null;
  pauseCount: number;
  startedAt: number;
  finishedAt: number | null;
}

export function instant(value: unknown): number | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function count(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function parseRunCounts(value: unknown): RunCounts {
  const counts = object(value);
  const byReason = object(counts.rejected_by_reason);
  const dropped = object(counts.contacts_dropped);
  const rate = typeof counts.match_rate === "number" && counts.match_rate >= 0 && counts.match_rate <= 1 ? counts.match_rate : null;
  return {
    rowsRead: count(counts.rows_read),
    rejected: count(counts.rejected),
    rejectedByReason: Object.entries(byReason)
      .flatMap(([reason, n]) => {
        const parsed = count(n);
        return parsed === null ? [] : [{ reason, count: parsed }];
      })
      .sort((a, b) => b.count - a.count),
    matchRate: rate,
    emailsDropped: count(dropped.email),
    phonesDropped: count(dropped.phone),
  };
}

/** Drops a row that breaks the table's checks, so one bad row never stops the page. */
export function parseRun(row: Record<string, unknown>): ImportRun | null {
  const createdAt = instant(row.created_at);
  const version = count(row.version);
  if (
    typeof row.id !== "string" ||
    typeof row.record_type_id !== "string" ||
    !isOneOf(RUN_STATES, row.state) ||
    !isOneOf(RUN_SOURCES, row.source) ||
    createdAt === null ||
    version === null
  ) {
    return null;
  }
  return {
    id: row.id,
    dataset: { id: row.record_type_id, displayName: text(row.display_name) ?? "Unknown dataset" },
    version,
    source: row.source,
    writer: typeof row.writer === "string" ? row.writer : "",
    format: text(row.format),
    byteSize: count(row.byte_size),
    fileKey: text(row.file_key),
    state: row.state,
    reason: text(row.reason),
    counts: parseRunCounts(row.counts),
    createdAt,
    startedAt: instant(row.started_at),
    finishedAt: instant(row.finished_at),
    approvedAt: instant(row.approved_at),
    firstPassAsOf: instant(row.first_pass_as_of),
  };
}

export function parsePass(row: Record<string, unknown>): MetricPass | null {
  const asOf = instant(row.as_of);
  const startedAt = instant(row.started_at);
  if (typeof row.id !== "string" || !isOneOf(PASS_STATES, row.state) || asOf === null || startedAt === null) return null;
  return {
    id: row.id,
    asOf,
    state: row.state,
    reason: text(row.reason),
    retryRequestedAt: instant(row.retry_requested_at),
    changedRows: count(row.changed_rows),
    walBytes: count(row.wal_bytes),
    pauseCount: Array.isArray(row.pauses) ? row.pauses.length : 0,
    startedAt,
    finishedAt: instant(row.finished_at),
  };
}

/** The file's name, from its drop-zone key. A rederive run has no file. */
export function fileName(run: Pick<ImportRun, "fileKey" | "source">): string {
  if (run.source === "rederive") return "Re-derive of stored rows";
  if (run.fileKey === null) return "API batch";
  return run.fileKey.slice(run.fileKey.lastIndexOf("/") + 1);
}

/** "Sent by": a source key's writer, or Studio for an upload or a re-derive. */
export function senderOf(run: Pick<ImportRun, "source" | "writer">): { by: string; kind: string } {
  switch (run.source) {
    case "studio":
      return { by: "Studio", kind: run.writer === "studio" || run.writer === "" ? "upload" : `uploaded by ${run.writer}` };
    case "rederive":
      return { by: "Studio", kind: "re-derive" };
    case "api":
    case "drop":
      return { by: run.writer, kind: "source key" };
    default: {
      const unhandled: never = run.source;
      return unhandled;
    }
  }
}

const FORMAT_LABELS: Record<string, string> = {
  csv: "CSV",
  "csv.gz": "CSV, compressed",
  ndjson: "NDJSON",
  "ndjson.gz": "NDJSON, compressed",
  xlsx: "Excel",
};

export function formatLabel(format: string | null): string | null {
  return format === null ? null : (FORMAT_LABELS[format] ?? format);
}

/** "18.2 MB": decimal units, one decimal from kB up. */
export function formatBytes(bytes: number): string {
  const units = ["kB", "MB", "GB", "TB"];
  if (bytes < 1000) return `${bytes} B`;
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** The run took from its start to its finish, or null while either is missing. */
export function runDuration(run: Pick<ImportRun, "startedAt" | "finishedAt">): number | null {
  return run.startedAt !== null && run.finishedAt !== null ? Math.max(0, run.finishedAt - run.startedAt) : null;
}

export function runsQuery(query: RunQuery): SqlQuery {
  const values: unknown[] = [];
  const where: string[] = [];
  if (query.filter !== "all") {
    values.push(FILTER_STATE[query.filter]);
    where.push(`r.state = $${values.length}`);
  }
  if (query.dataset !== null) {
    values.push(query.dataset);
    where.push(`r.record_type_id = $${values.length}`);
  }
  values.push(RUNS_PAGE_SIZE);
  return {
    text: `SELECT r.id, r.record_type_id, t.display_name, r.version, r.source, r.writer, r.format, r.byte_size, r.file_key,
                  r.state, r.reason, r.counts, r.created_at, r.started_at, r.finished_at, r.approved_at,
                  p.as_of AS first_pass_as_of
           FROM import_runs r
           JOIN import_record_types t ON t.id = r.record_type_id
           LEFT JOIN import_metric_passes p ON p.id = r.first_pass_id
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY r.created_at DESC, r.id
           LIMIT $${values.length}`,
    values,
  };
}

/** The filter chips' counts, over the dataset filter. */
export function runCountsQuery(dataset: string | null): SqlQuery {
  return {
    text: `SELECT count(*)::int AS all_runs,
                  count(*) FILTER (WHERE state = 'quarantined')::int AS held,
                  count(*) FILTER (WHERE state = 'failed')::int AS failed,
                  count(*) FILTER (WHERE state = 'queued')::int AS waiting
           FROM import_runs WHERE ($1::uuid IS NULL OR record_type_id = $1::uuid)`,
    values: [dataset],
  };
}

export function parseFilterCounts(row: Record<string, unknown> | undefined): Record<RunFilter, number> {
  return {
    all: count(row?.all_runs) ?? 0,
    held: count(row?.held) ?? 0,
    failed: count(row?.failed) ?? 0,
    waiting: count(row?.waiting) ?? 0,
  };
}

export const DATASET_OPTIONS_QUERY: SqlQuery = {
  text: `SELECT id, display_name FROM import_record_types ORDER BY display_name`,
  values: [],
};

export const PASSES_QUERY: SqlQuery = {
  text: `SELECT id, as_of, state, reason, retry_requested_at, changed_rows, wal_bytes, pauses, started_at, finished_at
         FROM import_metric_passes ORDER BY as_of DESC LIMIT ${PASSES_SHOWN}`,
  values: [],
};

/** The newest done pass, read apart from the shown passes so that a long run of failures cannot hide it. */
export const LATEST_DONE_PASS_QUERY: SqlQuery = {
  text: `SELECT id, as_of, state, reason, retry_requested_at, changed_rows, wal_bytes, pauses, started_at, finished_at
         FROM import_metric_passes WHERE state = 'done' ORDER BY as_of DESC LIMIT 1`,
  values: [],
};

export type Staleness =
  | { stale: false }
  | {
      stale: true;
      /** The as_of of the newest done pass, or null when none has finished. */
      valuesAsOf: number | null;
      ageDays: number | null;
      /** The passes since it that stopped, newest first. */
      stopped: MetricPass[];
      /** The newest stopped pass, which an admin may retry. */
      retry: MetricPass | null;
    };

/**
 * DIM-FR-20: the imported values are stale when the newest `done` pass is more than a day old, or
 * when no pass has finished but one has stopped. `passes` is newest first.
 */
export function stalenessOf(passes: readonly MetricPass[], latestDone: MetricPass | null, now: number): Staleness {
  const valuesAsOf = latestDone?.asOf ?? null;
  const stopped = passes.filter((pass) => pass.state === "failed" && (valuesAsOf === null || pass.asOf > valuesAsOf));
  const old = valuesAsOf !== null ? now - valuesAsOf > DAY_MS : stopped.length > 0;
  if (!old) return { stale: false };
  return {
    stale: true,
    valuesAsOf,
    ageDays: valuesAsOf === null ? null : Math.floor((now - valuesAsOf) / DAY_MS),
    stopped,
    retry: stopped[0] ?? null,
  };
}

/** A pass an admin may retry: stopped, and not already asked to run again. */
export function canRetryPass(pass: MetricPass): boolean {
  return pass.state === "failed" && pass.retryRequestedAt === null;
}

/** Studio's run transitions (import applier, Run states). A re-derive held for review can only be discarded. */
export function runActionsOf(run: Pick<ImportRun, "state" | "source">): { approve: boolean; discard: boolean; retry: boolean } {
  return {
    approve: run.state === "quarantined" && run.source !== "rederive",
    discard: run.state === "quarantined",
    retry: run.state === "failed",
  };
}

const RUN_TRANSITIONS = {
  approve: { from: "quarantined", to: "approved" },
  discard: { from: "quarantined", to: "discarded" },
  retry: { from: "failed", to: "queued" },
} as const satisfies Record<string, { from: RunState; to: RunState }>;

export type RunAction = keyof typeof RUN_TRANSITIONS;

/**
 * One conditional update from the state the transition leaves (IAP-FR-03), so a second click or a
 * race with the applier changes nothing. Approve also stamps who approved and when.
 */
export function runTransitionQuery(action: RunAction, runId: string, adminId: string): SqlQuery {
  const { from, to } = RUN_TRANSITIONS[action];
  if (action === "approve") {
    return {
      text: `UPDATE import_runs SET state = $2, approved_by = $4, approved_at = now()
             WHERE id = $1 AND state = $3 AND source <> 'rederive' RETURNING id`,
      values: [runId, to, from, adminId],
    };
  }
  return {
    text: `UPDATE import_runs SET state = $2 WHERE id = $1 AND state = $3 RETURNING id`,
    values: [runId, to, from],
  };
}

/** DIM-FR-20: a pass retry stamps retry_requested_at and nothing else. */
export function passRetryQuery(passId: string): SqlQuery {
  return {
    text: `UPDATE import_metric_passes SET retry_requested_at = now()
           WHERE id = $1 AND state = 'failed' AND retry_requested_at IS NULL RETURNING id`,
    values: [passId],
  };
}
