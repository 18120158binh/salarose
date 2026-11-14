import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { StoredSourceKey } from "@/lib/db";
import { authenticateSourceKey, failure, readCapped } from "../../data-ingestion/model/sourceKeyAuth";
import { createDropZone, type DropZone, dropZoneBucket } from "./dropZone";
import {
  type DatasetForKey,
  findDatasetForKey,
  findLiveRunBySha,
  findRunOfWriter,
  insertRun,
  queueUploadedRun,
  type StoredRun,
} from "./importRuns";

// The batch API of data import (DIM-FR-08 to DIM-FR-14, DIM-FR-29, DIA-FR-40). Every refusal in the
// status table answers before a run exists. Logs name the source's app id and the run id, never
// the key or a row value (DIM-NFR-06).

const LABEL = "Import API";
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_RECORDS = 1000;
export const MAX_RECORDS_BYTES = 5 * 1024 * 1024;
const MAX_CREATE_BODY_BYTES = 16 * 1024;
const FORMATS = ["csv", "ndjson", "csv.gz", "ndjson.gz"] as const;
type Format = (typeof FORMATS)[number];
const SYSTEM_NAME = /^[a-z][a-z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Swapped in tests. Null when `IMPORTS_BUCKET` is unset. */
export function dropZoneFromEnv(): DropZone | null {
  const bucket = dropZoneBucket(process.env);
  return bucket ? createDropZone(bucket) : null;
}

const unavailable = () => failure(503, "The service is unavailable. Try again.");
const notConfigured = () => failure(503, "The service is not configured.");
const runNotFound = () => failure(404, "No such run.");

interface CreateImport {
  recordType: string;
  fileName: string;
  byteSize: number;
  sha256: string;
  format: Format;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

function parseCreateImport(text: string): Parsed<CreateImport> {
  const bad = (error: string): Parsed<CreateImport> => ({ ok: false, response: failure(400, error) });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("The body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("The body must be a JSON object.");
  const { record_type, file_name, byte_size, sha256, format } = body as Record<string, unknown>;
  if (typeof record_type !== "string" || !SYSTEM_NAME.test(record_type)) return bad("record_type must be a dataset's system name.");
  if (typeof file_name !== "string" || file_name.trim() === "" || file_name.length > 255) {
    return bad("file_name must be 1 to 255 characters.");
  }
  if (typeof byte_size !== "number" || !Number.isSafeInteger(byte_size) || byte_size < 1) {
    return bad("byte_size must be a positive integer.");
  }
  if (typeof sha256 !== "string" || !SHA256.test(sha256.toLowerCase())) return bad("sha256 must be 64 hex characters.");
  if (typeof format !== "string" || !(FORMATS as readonly string[]).includes(format)) {
    return bad(`format must be one of ${FORMATS.join(", ")}.`);
  }
  if (byte_size > MAX_FILE_BYTES) return { ok: false, response: fileTooLarge() };
  return { ok: true, value: { recordType: record_type, fileName: file_name, byteSize: byte_size, sha256: sha256.toLowerCase(), format: format as Format } };
}

function fileTooLarge() {
  return failure(413, `A file holds at most ${MAX_FILE_BYTES} bytes.`);
}

function recordsTooLarge() {
  return failure(413, `A records body holds at most ${MAX_RECORDS_BYTES} bytes.`);
}

/** imports/incoming/<app_id>/<record_type>/<yyyy-mm-dd>/<run_id>.<ext> */
export function incomingFileKey(appId: string, recordType: string, now: Date, runId: string, format: Format): string {
  return `imports/incoming/${appId}/${recordType}/${now.toISOString().slice(0, 10)}/${runId}.${format}`;
}

/** 404 for a dataset that does not exist, 403 for a key without its scope or not its one writer. */
async function datasetFor(
  source: StoredSourceKey,
  recordType: string,
): Promise<{ ok: true; dataset: DatasetForKey } | { ok: false; response: NextResponse }> {
  let dataset: DatasetForKey | null;
  try {
    dataset = await findDatasetForKey(recordType, source.id);
  } catch (error) {
    console.error(`${LABEL} from ${source.appId}: the dataset lookup failed:`, error);
    return { ok: false, response: unavailable() };
  }
  if (!dataset) return { ok: false, response: failure(404, `No dataset named "${recordType}".`) };
  if (!dataset.scoped) return { ok: false, response: failure(403, "This source key may not import this dataset.") };
  // DIM-FR-09: studio refuses a second writer of a snapshot type. This holds even if one slipped in.
  if (dataset.deliveryMode === "snapshot" && dataset.otherWriters > 0) {
    return { ok: false, response: failure(403, "This snapshot dataset has another writer.") };
  }
  return { ok: true, dataset };
}

/** POST /v1/imports */
export async function createImport(req: Request): Promise<NextResponse> {
  const auth = await authenticateSourceKey(req, LABEL);
  if (!auth.ok) return auth.response;
  const { source } = auth;

  const text = await readCapped(req, MAX_CREATE_BODY_BYTES);
  if (text === null) return failure(413, `The body holds at most ${MAX_CREATE_BODY_BYTES} bytes.`);
  const parsed = parseCreateImport(text);
  if (!parsed.ok) return parsed.response;
  const request = parsed.value;

  const found = await datasetFor(source, request.recordType);
  if (!found.ok) return found.response;
  const { dataset } = found;

  const dropZone = dropZoneFromEnv();
  if (!dropZone) {
    console.error(`${LABEL} needs IMPORTS_BUCKET.`);
    return notConfigured();
  }

  try {
    const duplicate = await findLiveRunBySha(dataset.id, request.sha256);
    if (duplicate) return NextResponse.json({ run_id: duplicate.id, state: duplicate.state, duplicate: true });

    const now = new Date();
    const runId = randomUUID();
    const fileKey = incomingFileKey(source.appId, request.recordType, now, runId, request.format);
    // Sign first: a run exists only once its upload URL does.
    const upload = await dropZone.presignUpload(fileKey, request.byteSize, request.sha256, now);
    await insertRun({
      id: runId,
      recordTypeId: dataset.id,
      version: dataset.version,
      source: "drop",
      writer: source.id,
      format: request.format,
      byteSize: request.byteSize,
      fileKey,
      sha256: request.sha256,
      state: "uploading",
    });
    return NextResponse.json(
      {
        run_id: runId,
        state: "uploading",
        duplicate: false,
        upload: { url: upload.url, method: upload.method, headers: upload.headers, expires_at: upload.expiresAt },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error(`${LABEL} from ${source.appId}: creating a run failed:`, error);
    return unavailable();
  }
}

async function runOfSource(source: StoredSourceKey, runId: string): Promise<{ ok: true; run: StoredRun } | { ok: false; response: NextResponse }> {
  if (!UUID.test(runId)) return { ok: false, response: runNotFound() };
  try {
    const run = await findRunOfWriter(runId, source.id);
    return run ? { ok: true, run } : { ok: false, response: runNotFound() };
  } catch (error) {
    console.error(`${LABEL} from ${source.appId}: reading run ${runId} failed:`, error);
    return { ok: false, response: unavailable() };
  }
}

/** POST /v1/imports/{run_id}/complete */
export async function completeImport(req: Request, runId: string): Promise<NextResponse> {
  const auth = await authenticateSourceKey(req, LABEL);
  if (!auth.ok) return auth.response;
  const { source } = auth;

  const found = await runOfSource(source, runId);
  if (!found.ok) return found.response;
  const { run } = found;
  if (run.state === "expired") return failure(409, "run_expired");
  // DIM-FR-11: a retried complete is safe.
  if (run.state !== "uploading") return NextResponse.json({ run_id: run.id, state: run.state });

  const dropZone = dropZoneFromEnv();
  if (!dropZone) {
    console.error(`${LABEL} needs IMPORTS_BUCKET.`);
    return notConfigured();
  }
  try {
    const stored = run.fileKey ? await dropZone.inspect(run.fileKey) : null;
    if (!stored) return failure(422, "upload_missing");
    if (stored.byteSize !== run.byteSize) return failure(422, "size_mismatch");
    if (stored.sha256 !== run.sha256) return failure(422, "checksum_mismatch");
    const state = await queueUploadedRun(run.id);
    if (state === "expired") return failure(409, "run_expired");
    return NextResponse.json({ run_id: run.id, state });
  } catch (error) {
    console.error(`${LABEL} from ${source.appId}: completing run ${run.id} failed:`, error);
    return unavailable();
  }
}

/** GET /v1/imports/{run_id}: the state and the report, never a row value (DIM-FR-13). */
export async function getImport(req: Request, runId: string): Promise<NextResponse> {
  const auth = await authenticateSourceKey(req, LABEL);
  if (!auth.ok) return auth.response;
  const found = await runOfSource(auth.source, runId);
  if (!found.ok) return found.response;
  const { run } = found;
  return NextResponse.json({
    run_id: run.id,
    record_type: run.recordType,
    state: run.state,
    reason: run.reason,
    counts: run.counts,
    first_pass_id: run.firstPassId,
    created_at: run.createdAt,
    confirmed_at: run.confirmedAt,
    finished_at: run.finishedAt,
  });
}

function parseRecords(text: string): Parsed<object[]> {
  const bad = (): Parsed<object[]> => ({ ok: false, response: failure(400, "The body must be JSON with a records list of objects.") });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad();
  }
  if (typeof body !== "object" || body === null) return bad();
  const records = (body as { records?: unknown }).records;
  if (!Array.isArray(records) || records.length === 0) return bad();
  if (!records.every((record) => typeof record === "object" && record !== null && !Array.isArray(record))) return bad();
  if (records.length > MAX_RECORDS) return { ok: false, response: failure(422, "too_many_records") };
  return { ok: true, value: records as object[] };
}

/** POST /v1/records/{record_type}: one NDJSON file in the drop zone and one queued run (DIM-FR-12). */
export async function postRecords(req: Request, recordType: string): Promise<NextResponse> {
  const auth = await authenticateSourceKey(req, LABEL);
  if (!auth.ok) return auth.response;
  const { source } = auth;

  const text = await readCapped(req, MAX_RECORDS_BYTES);
  if (text === null) return recordsTooLarge();
  const parsed = parseRecords(text);
  if (!parsed.ok) return parsed.response;

  if (!SYSTEM_NAME.test(recordType)) return failure(404, `No dataset named "${recordType}".`);
  const found = await datasetFor(source, recordType);
  if (!found.ok) return found.response;
  const { dataset } = found;
  // A batch applied as a snapshot would remove every other row of the type.
  if (dataset.deliveryMode === "snapshot") return failure(409, "snapshot_type");

  const dropZone = dropZoneFromEnv();
  if (!dropZone) {
    console.error(`${LABEL} needs IMPORTS_BUCKET.`);
    return notConfigured();
  }

  const body = Buffer.from(parsed.value.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const now = new Date();
  const runId = randomUUID();
  const fileKey = incomingFileKey(source.appId, recordType, now, runId, "ndjson");
  try {
    // The file first: a run exists only once its file does.
    await dropZone.put(fileKey, body, sha256);
    await insertRun({
      id: runId,
      recordTypeId: dataset.id,
      version: dataset.version,
      source: "api",
      writer: source.id,
      format: "ndjson",
      byteSize: body.byteLength,
      fileKey,
      sha256,
      state: "queued",
    });
  } catch (error) {
    console.error(`${LABEL} from ${source.appId}: storing a records batch failed:`, error);
    return unavailable();
  }
  return NextResponse.json({ run_id: runId, state: "queued" }, { status: 202 });
}
