import "server-only";
import { inTransaction, type RunQuery } from "@/lib/db";
import { runOn } from "./server";

// The import_runs rows and scope reads behind the batch API. Each run transition is one
// conditional update from the state it leaves, as the import applier's run states require.

export type DeliveryMode = "incremental" | "snapshot";

export type RunState =
  | "uploading"
  | "queued"
  | "validating"
  | "quarantined"
  | "approved"
  | "discarded"
  | "applying"
  | "applied"
  | "failed"
  | "expired";

/** The states whose `sha256` makes a new file of the type a duplicate (DIM-FR-10). */
export const LIVE_STATES: readonly RunState[] = ["queued", "validating", "quarantined", "approved", "applying", "applied"];

export interface DatasetForKey {
  id: string;
  version: number;
  deliveryMode: DeliveryMode;
  /** The key holds a scope for the dataset. */
  scoped: boolean;
  /** Other unrevoked keys scoped to the dataset. */
  otherWriters: number;
}

export interface NewRun {
  id: string;
  recordTypeId: string;
  version: number;
  source: "drop" | "api";
  writer: string;
  format: string;
  byteSize: number;
  fileKey: string;
  sha256: string;
  state: "uploading" | "queued";
}

export interface StoredRun {
  id: string;
  recordType: string;
  state: RunState;
  reason: string | null;
  counts: Record<string, unknown>;
  byteSize: number | null;
  fileKey: string | null;
  sha256: string | null;
  firstPassId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
}

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

async function query<T>(work: (run: RunQuery) => Promise<T>): Promise<T> {
  return inTransaction((client) => work(runOn(client)));
}

export function findDatasetForKey(name: string, sourceKeyId: string): Promise<DatasetForKey | null> {
  return query(async (run) => {
    const [row] = await run({
      text: `SELECT t.id, t.current_version, v.delivery_mode,
                    EXISTS (SELECT 1 FROM import_source_scopes s WHERE s.record_type_id = t.id AND s.source_key_id = $2) AS scoped,
                    (SELECT count(*) FROM import_source_scopes s JOIN ingestion_source_keys k ON k.id = s.source_key_id
                      WHERE s.record_type_id = t.id AND s.source_key_id <> $2 AND k.revoked_at IS NULL)::int AS other_writers
               FROM import_record_types t
               JOIN import_record_type_versions v ON v.record_type_id = t.id AND v.version = t.current_version
              WHERE t.name = $1`,
      values: [name, sourceKeyId],
    });
    if (!row) return null;
    return {
      id: String(row.id),
      version: Number(row.current_version),
      deliveryMode: row.delivery_mode === "snapshot" ? "snapshot" : "incremental",
      scoped: row.scoped === true,
      otherWriters: Number(row.other_writers),
    };
  });
}

/** The oldest run of the type at a live state with this `sha256`, or null. */
export function findLiveRunBySha(recordTypeId: string, sha256: string): Promise<{ id: string; state: RunState } | null> {
  return query(async (run) => {
    const [row] = await run({
      text: `SELECT id, state FROM import_runs
              WHERE record_type_id = $1 AND sha256 = $2 AND state = ANY($3::text[])
              ORDER BY created_at, id LIMIT 1`,
      values: [recordTypeId, sha256, LIVE_STATES],
    });
    return row ? { id: String(row.id), state: row.state as RunState } : null;
  });
}

/** A run at `queued` is confirmed now, and its stored file is the delivered one. */
export function insertRun(newRun: NewRun): Promise<void> {
  return query(async (run) => {
    await run({
      text: `INSERT INTO import_runs (id, record_type_id, version, source, writer, format, byte_size, file_key, sha256, stored_sha256, state, confirmed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 = 'queued' THEN $9 END, $10,
                     CASE WHEN $10 = 'queued' THEN CURRENT_TIMESTAMP END)`,
      values: [
        newRun.id,
        newRun.recordTypeId,
        newRun.version,
        newRun.source,
        newRun.writer,
        newRun.format,
        newRun.byteSize,
        newRun.fileKey,
        newRun.sha256,
        newRun.state,
      ],
    });
  });
}

/** The run, only when this writer wrote it (DIM-FR-13). */
export function findRunOfWriter(runId: string, writer: string): Promise<StoredRun | null> {
  return query(async (run) => {
    const [row] = await run({
      text: `SELECT r.id, t.name AS record_type, r.state, r.reason, r.counts, r.byte_size, r.file_key, r.sha256,
                    r.first_pass_id, r.created_at, r.confirmed_at, r.finished_at
               FROM import_runs r JOIN import_record_types t ON t.id = r.record_type_id
              WHERE r.id = $1 AND r.writer = $2`,
      values: [runId, writer],
    });
    if (!row) return null;
    return {
      id: String(row.id),
      recordType: String(row.record_type),
      state: row.state as RunState,
      reason: row.reason === null ? null : String(row.reason),
      counts: (row.counts ?? {}) as Record<string, unknown>,
      byteSize: row.byte_size === null ? null : Number(row.byte_size),
      fileKey: row.file_key === null ? null : String(row.file_key),
      sha256: row.sha256 === null ? null : String(row.sha256),
      firstPassId: row.first_pass_id === null ? null : String(row.first_pass_id),
      createdAt: iso(row.created_at) ?? "",
      confirmedAt: iso(row.confirmed_at),
      finishedAt: iso(row.finished_at),
    };
  });
}

/**
 * `uploading` to `queued`, when the upload is confirmed. Returns the run's state after the
 * update: `queued`, or the state another actor moved it to first.
 */
export function queueUploadedRun(runId: string): Promise<RunState> {
  return query(async (run) => {
    const [updated] = await run({
      text: `UPDATE import_runs SET state = 'queued', stored_sha256 = sha256, confirmed_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND state = 'uploading' RETURNING state`,
      values: [runId],
    });
    if (updated) return updated.state as RunState;
    const [current] = await run({ text: `SELECT state FROM import_runs WHERE id = $1`, values: [runId] });
    return current.state as RunState;
  });
}
