/**
 * @jest-environment node
 */
import { createHash } from "node:crypto";
import * as db from "@/lib/db";
import type { DropZone, StoredObject } from "../../../../src/features/data-import/model/dropZone";
import type { DatasetForKey, NewRun, RunState } from "../../../../src/features/data-import/model/importRuns";
import { hashSourceKey } from "../../../../src/features/data-ingestion/model/sourceKeys";
import { GET } from "../[run_id]/route";
import { POST as COMPLETE } from "../[run_id]/complete/route";
import { POST as RECORDS } from "../../records/[record_type]/route";
import { POST as CREATE } from "../route";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/db", () => ({ findSourceKeyByHash: jest.fn() }));

// The database behind the batch API, in memory: datasets, scopes, and runs.
interface FakeDataset {
  id: string;
  name: string;
  version: number;
  deliveryMode: "incremental" | "snapshot";
}
interface FakeRun extends Omit<NewRun, "state"> {
  storedSha256: string | null;
  state: RunState;
  confirmed: boolean;
}
const mockStore = {
  datasets: [] as FakeDataset[],
  scopes: [] as { keyId: string; typeId: string }[],
  revokedKeys: new Set<string>(),
  runs: new Map<string, FakeRun>(),
};
jest.mock("../../../../src/features/data-import/model/importRuns", () => {
  const live = ["queued", "validating", "quarantined", "approved", "applying", "applied"];
  return {
    findDatasetForKey: async (name: string, keyId: string): Promise<DatasetForKey | null> => {
      const dataset = mockStore.datasets.find((d) => d.name === name);
      if (!dataset) return null;
      const holders = mockStore.scopes.filter((s) => s.typeId === dataset.id && !mockStore.revokedKeys.has(s.keyId));
      return {
        id: dataset.id,
        version: dataset.version,
        deliveryMode: dataset.deliveryMode,
        scoped: mockStore.scopes.some((s) => s.typeId === dataset.id && s.keyId === keyId),
        otherWriters: holders.filter((s) => s.keyId !== keyId).length,
      };
    },
    findLiveRunBySha: async (typeId: string, sha256: string) => {
      const run = [...mockStore.runs.values()].find((r) => r.recordTypeId === typeId && r.sha256 === sha256 && live.includes(r.state));
      return run ? { id: run.id, state: run.state } : null;
    },
    insertRun: async (run: NewRun) => {
      mockStore.runs.set(run.id, { ...run, storedSha256: run.state === "queued" ? run.sha256 : null, confirmed: run.state === "queued" });
    },
    findRunOfWriter: async (runId: string, writer: string) => {
      const run = mockStore.runs.get(runId);
      if (!run || run.writer !== writer) return null;
      const dataset = mockStore.datasets.find((d) => d.id === run.recordTypeId)!;
      return {
        id: run.id,
        recordType: dataset.name,
        state: run.state,
        reason: run.state === "quarantined" ? "threshold" : null,
        counts: { rows: 3, valid: 2, rejected: 1 },
        byteSize: run.byteSize,
        fileKey: run.fileKey,
        sha256: run.sha256,
        firstPassId: null,
        createdAt: "2026-11-14T01:40:00.000Z",
        confirmedAt: null,
        finishedAt: null,
      };
    },
    queueUploadedRun: async (runId: string) => {
      const run = mockStore.runs.get(runId)!;
      if (run.state === "uploading") Object.assign(run, { state: "queued", storedSha256: run.sha256, confirmed: true });
      return run.state;
    },
  };
});

// The drop zone, in memory. Presigning is checked against the real SDK in dropZone.test.ts.
const mockObjects = new Map<string, StoredObject>();
const mockPuts: { fileKey: string; body: string; sha256: string }[] = [];
const mockDropZone: DropZone = {
  presignUpload: async (fileKey, byteSize, sha256, now) => ({
    url: `https://bucket.s3.amazonaws.com/${fileKey}?X-Amz-Expires=900`,
    method: "PUT",
    headers: { "Content-Length": String(byteSize), "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64") },
    expiresAt: new Date(now.getTime() + 900_000).toISOString(),
  }),
  inspect: async (fileKey) => mockObjects.get(fileKey) ?? null,
  put: async (fileKey, body, sha256) => {
    mockPuts.push({ fileKey, body: body.toString("utf8"), sha256 });
  },
};
jest.mock("../../../../src/features/data-import/model/dropZone", () => ({
  ...jest.requireActual("../../../../src/features/data-import/model/dropZone"),
  createDropZone: () => mockDropZone,
}));

const ORDERS = "11111111-1111-4111-8111-111111111111";
const CUSTOMERS = "22222222-2222-4222-8222-222222222222";
const SHA = "9f2c41d0e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1";
const MiB = 1024 * 1024;

// Each test gets keys of its own, because the rate limit lives for the whole file.
let testNumber = 0;
let sk12 = "";
let sk14 = "";
let revokedKey = "";
let unscopedKey = "";
const logged: string[] = [];

beforeEach(() => {
  testNumber += 1;
  sk12 = `cdp_sk_shop_${testNumber}`;
  sk14 = `cdp_sk_other_${testNumber}`;
  revokedKey = `cdp_sk_revoked_${testNumber}`;
  unscopedKey = `cdp_sk_unscoped_${testNumber}`;
  const keys = new Map<string, db.StoredSourceKey>([
    [hashSourceKey(sk12), { id: "sk_12", appId: "shop-erp", revoked: false }],
    [hashSourceKey(sk14), { id: "sk_14", appId: "shop-crm", revoked: false }],
    [hashSourceKey(revokedKey), { id: "sk_9", appId: "old-erp", revoked: true }],
    [hashSourceKey(unscopedKey), { id: "sk_20", appId: "web", revoked: false }],
  ]);
  jest.mocked(db.findSourceKeyByHash).mockImplementation(async (hash) => keys.get(hash) ?? null);
  process.env.IMPORTS_BUCKET = "drop-zone";
  delete process.env.INGESTION_RATE_LIMIT_PER_SECOND;
  mockStore.datasets = [
    { id: ORDERS, name: "orders", version: 3, deliveryMode: "incremental" },
    { id: CUSTOMERS, name: "customers", version: 1, deliveryMode: "snapshot" },
  ];
  mockStore.scopes = [
    { keyId: "sk_12", typeId: ORDERS },
    { keyId: "sk_12", typeId: CUSTOMERS },
    { keyId: "sk_14", typeId: ORDERS },
  ];
  mockStore.revokedKeys = new Set(["sk_9"]);
  mockStore.runs.clear();
  mockObjects.clear();
  mockPuts.length = 0;
  logged.length = 0;
  for (const method of ["log", "info", "warn", "error"] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(" "));
    });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

type Reply = { status: number; body: Record<string, unknown>; retryAfter: string | null };

async function reply(response: Response): Promise<Reply> {
  return { status: response.status, body: await response.json(), retryAfter: response.headers.get("Retry-After") };
}

function request(path: string, key: string | null, init: { method?: string; body?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return new Request(`https://studio.test${path}`, { method: init.method ?? "POST", headers, body: init.body });
}

const fileRequest = (overrides: Record<string, unknown> = {}) => ({
  record_type: "orders",
  file_name: "orders-2026-11-07.csv.gz",
  byte_size: 18204411,
  sha256: SHA,
  format: "csv.gz",
  ...overrides,
});

async function create(key: string | null, body: unknown = fileRequest()) {
  return reply(await CREATE(request("/v1/imports", key, { body: typeof body === "string" ? body : JSON.stringify(body) })));
}

async function complete(key: string, runId: string) {
  return reply(await COMPLETE(request(`/v1/imports/${runId}/complete`, key), { params: Promise.resolve({ run_id: runId }) }));
}

async function read(key: string, runId: string) {
  return reply(await GET(request(`/v1/imports/${runId}`, key, { method: "GET" }), { params: Promise.resolve({ run_id: runId }) }));
}

async function postRecords(key: string, recordType: string, body: unknown) {
  return reply(
    await RECORDS(request(`/v1/records/${recordType}`, key, { body: typeof body === "string" ? body : JSON.stringify(body) }), {
      params: Promise.resolve({ record_type: recordType }),
    }),
  );
}

const orders = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ order_id: `o-${i}`, customer_id: `c-${i}`, created_at: "2026-11-07T10:00:00Z", total: 1450000 }));

/** A run at `uploading` whose object is in the drop zone as given. */
async function uploaded(object: StoredObject | null = { byteSize: 18204411, sha256: SHA }) {
  const created = await create(sk12);
  const runId = String(created.body.run_id);
  if (object) mockObjects.set(mockStore.runs.get(runId)!.fileKey, object);
  return runId;
}

describe("POST /v1/imports", () => {
  it("creates a run at uploading and returns a presigned PUT for one object, valid 15 minutes, with no credential (DIM-FR-10, DIM-NFR-03)", async () => {
    const result = await create(sk12);

    expect(result.status).toBe(201);
    const runId = String(result.body.run_id);
    const run = mockStore.runs.get(runId)!;
    expect(run).toMatchObject({
      recordTypeId: ORDERS,
      version: 3,
      source: "drop",
      writer: "sk_12",
      format: "csv.gz",
      byteSize: 18204411,
      sha256: SHA,
      state: "uploading",
    });
    expect(run.fileKey).toMatch(new RegExp(`^imports/incoming/shop-erp/orders/\\d{4}-\\d{2}-\\d{2}/${runId}\\.csv\\.gz$`));
    expect(result.body).toMatchObject({ run_id: runId, state: "uploading", duplicate: false });
    const upload = result.body.upload as Record<string, unknown>;
    expect(upload.method).toBe("PUT");
    expect(String(upload.url)).toContain(run.fileKey);
    expect(Date.parse(String(upload.expires_at)) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(String(upload.expires_at)) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  it.each([
    ["missing", null],
    ["unknown", "cdp_sk_nobody"],
  ])("refuses a %s key with 401 and creates no run", async (_case, key) => {
    expect((await create(key)).status).toBe(401);
    expect(mockStore.runs.size).toBe(0);
  });

  it("refuses a revoked key with 401 (DIA-FR-40)", async () => {
    expect((await create(revokedKey)).status).toBe(401);
    expect(mockStore.runs.size).toBe(0);
  });

  it("refuses a key without import scopes with 403 (DIA-FR-40)", async () => {
    expect((await create(unscopedKey)).status).toBe(403);
    expect(mockStore.runs.size).toBe(0);
  });

  it("refuses a key scoped to orders that posts customers with 403 (DIM-FR-08)", async () => {
    expect((await create(sk14, fileRequest({ record_type: "customers" }))).status).toBe(403);
    expect(mockStore.runs.size).toBe(0);
  });

  it("refuses the second writer of a snapshot type with 403, even when a scope slipped in (DIM-FR-09)", async () => {
    mockStore.scopes.push({ keyId: "sk_14", typeId: CUSTOMERS });

    expect((await create(sk14, fileRequest({ record_type: "customers" }))).status).toBe(403);
    expect(mockStore.runs.size).toBe(0);
  });

  it("lets the snapshot type's one writer import it", async () => {
    expect((await create(sk12, fileRequest({ record_type: "customers" }))).status).toBe(201);
  });

  it("refuses a dataset that does not exist with 404", async () => {
    expect((await create(sk12, fileRequest({ record_type: "refunds" }))).status).toBe(404);
    expect(mockStore.runs.size).toBe(0);
  });

  it("refuses a byte_size of 600 MiB with 413 (DIM-FR-14)", async () => {
    expect((await create(sk12, fileRequest({ byte_size: 600 * MiB }))).status).toBe(413);
    expect(mockStore.runs.size).toBe(0);
  });

  it("accepts a byte_size of exactly 512 MiB", async () => {
    expect((await create(sk12, fileRequest({ byte_size: 512 * MiB }))).status).toBe(201);
  });

  it.each([
    ["a body that is not JSON", "{record_type"],
    ["a missing field", { ...fileRequest(), sha256: undefined }],
    ["a field of the wrong type", fileRequest({ byte_size: "18204411" })],
    ["an unknown format", fileRequest({ format: "xlsx" })],
    ["a sha256 that is not 64 hex characters", fileRequest({ sha256: "abc" })],
  ])("refuses %s with 400 and creates no run (DIM-FR-29)", async (_case, body) => {
    expect((await create(sk12, body)).status).toBe(400);
    expect(mockStore.runs.size).toBe(0);
  });

  it.each(["queued", "validating", "quarantined", "approved", "applying", "applied"] as const)(
    "returns the run at %s with duplicate: true and no URL for the same sha256 (DIM-FR-10)",
    async (state) => {
      const runId = await uploaded();
      mockStore.runs.get(runId)!.state = state;

      const again = await create(sk12);

      expect(again).toMatchObject({ status: 200, body: { run_id: runId, state, duplicate: true } });
      expect(again.body).not.toHaveProperty("upload");
      expect(mockStore.runs.size).toBe(1);
    },
  );

  it.each(["uploading", "expired", "discarded", "failed"] as const)("creates a new run when the same sha256 is only at %s", async (state) => {
    const runId = await uploaded();
    mockStore.runs.get(runId)!.state = state;

    expect((await create(sk12)).body.duplicate).toBe(false);
    expect(mockStore.runs.size).toBe(2);
  });

  it("checks the duplicate against runs of the same type only", async () => {
    const runId = await uploaded();
    mockStore.runs.get(runId)!.state = "applied";

    expect((await create(sk12, fileRequest({ record_type: "customers" }))).body.duplicate).toBe(false);
  });

  it("answers 429 over the key's rate limit and creates no run (DIM-NFR-05)", async () => {
    process.env.INGESTION_RATE_LIMIT_PER_SECOND = "1";
    expect((await create(sk12)).status).toBe(201);

    const limited = await create(sk12, fileRequest({ sha256: "a".repeat(64) }));

    expect(limited.status).toBe(429);
    expect(limited.retryAfter).toBe("1");
    expect(mockStore.runs.size).toBe(1);
  });

  it("answers 503 and creates no run when IMPORTS_BUCKET is unset", async () => {
    delete process.env.IMPORTS_BUCKET;
    expect((await create(sk12)).status).toBe(503);
    expect(mockStore.runs.size).toBe(0);
  });
});

describe("POST /v1/imports/{run_id}/complete", () => {
  it("queues the run when the object's size and SHA-256 match (DIM-FR-11)", async () => {
    const runId = await uploaded();

    expect(await complete(sk12, runId)).toMatchObject({ status: 200, body: { run_id: runId, state: "queued" } });
    expect(mockStore.runs.get(runId)).toMatchObject({ state: "queued", storedSha256: SHA, confirmed: true });
  });

  it("answers 422 and keeps the run at uploading when the object is 10 bytes short (DIM-FR-11)", async () => {
    const runId = await uploaded({ byteSize: 18204401, sha256: SHA });

    expect(await complete(sk12, runId)).toMatchObject({ status: 422, body: { error: "size_mismatch" } });
    expect(mockStore.runs.get(runId)!.state).toBe("uploading");
  });

  it("answers 422 and keeps the run at uploading when the SHA-256 differs", async () => {
    const runId = await uploaded({ byteSize: 18204411, sha256: "b".repeat(64) });

    expect(await complete(sk12, runId)).toMatchObject({ status: 422, body: { error: "checksum_mismatch" } });
    expect(mockStore.runs.get(runId)!.state).toBe("uploading");
  });

  it("answers 422 when S3 holds no SHA-256 for the object, as after a PUT without the checksum header", async () => {
    const runId = await uploaded({ byteSize: 18204411, sha256: null });

    expect((await complete(sk12, runId)).status).toBe(422);
    expect(mockStore.runs.get(runId)!.state).toBe("uploading");
  });

  it("answers 422 before the upload finished, and queues on the retry after it", async () => {
    const runId = await uploaded(null);

    expect(await complete(sk12, runId)).toMatchObject({ status: 422, body: { error: "upload_missing" } });
    mockObjects.set(mockStore.runs.get(runId)!.fileKey, { byteSize: 18204411, sha256: SHA });
    expect((await complete(sk12, runId)).body.state).toBe("queued");
  });

  it("answers a second complete with 200 and the run's state, and changes nothing (DIM-FR-11)", async () => {
    const runId = await uploaded();
    await complete(sk12, runId);
    const before = { ...mockStore.runs.get(runId)! };
    mockObjects.clear();

    expect(await complete(sk12, runId)).toMatchObject({ status: 200, body: { run_id: runId, state: "queued" } });
    expect(mockStore.runs.get(runId)).toEqual(before);
  });

  it("answers 200 with the state of a run already applied", async () => {
    const runId = await uploaded();
    mockStore.runs.get(runId)!.state = "applied";

    expect(await complete(sk12, runId)).toMatchObject({ status: 200, body: { state: "applied" } });
  });

  it("answers 409 run_expired on an expired run", async () => {
    const runId = await uploaded();
    mockStore.runs.get(runId)!.state = "expired";

    expect(await complete(sk12, runId)).toMatchObject({ status: 409, body: { error: "run_expired" } });
    expect(mockStore.runs.get(runId)!.state).toBe("expired");
  });

  it("answers 404 when another key completes the run", async () => {
    const runId = await uploaded();

    expect((await complete(sk14, runId)).status).toBe(404);
    expect(mockStore.runs.get(runId)!.state).toBe("uploading");
  });

  it("answers 404 for a run id that is not a UUID", async () => {
    expect((await complete(sk12, "../orders")).status).toBe(404);
  });

  it("refuses a revoked key with 401", async () => {
    const runId = await uploaded();
    expect((await complete(revokedKey, runId)).status).toBe(401);
  });
});

describe("GET /v1/imports/{run_id}", () => {
  it("returns the state, the report, and first_pass_id to the key that wrote the run (DIM-FR-13)", async () => {
    const runId = await uploaded();

    expect(await read(sk12, runId)).toMatchObject({
      status: 200,
      body: { run_id: runId, record_type: "orders", state: "uploading", counts: { rows: 3, valid: 2, rejected: 1 }, first_pass_id: null },
    });
  });

  it("answers 404 when another key reads the run (DIM-FR-13)", async () => {
    const runId = await uploaded();

    expect((await read(sk14, runId)).status).toBe(404);
  });
});

describe("POST /v1/records/{record_type}", () => {
  it("stores 1,000 records as one NDJSON file and queues one run (DIM-FR-12)", async () => {
    const result = await postRecords(sk12, "orders", { records: orders(1000) });

    expect(result.status).toBe(202);
    expect(mockStore.runs.size).toBe(1);
    expect(mockPuts).toHaveLength(1);
    const [put] = mockPuts;
    const lines = put.body.trimEnd().split("\n");
    expect(lines).toHaveLength(1000);
    expect(JSON.parse(lines[0])).toEqual(orders(1)[0]);
    expect(put.sha256).toBe(createHash("sha256").update(put.body).digest("hex"));
    const run = mockStore.runs.get(String(result.body.run_id))!;
    expect(run).toMatchObject({
      source: "api",
      writer: "sk_12",
      format: "ndjson",
      state: "queued",
      fileKey: put.fileKey,
      sha256: put.sha256,
      storedSha256: put.sha256,
      byteSize: Buffer.byteLength(put.body),
      confirmed: true,
    });
    expect(put.fileKey).toMatch(/^imports\/incoming\/shop-erp\/orders\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.ndjson$/);
  });

  it("answers 422 too_many_records for 1,001 records and creates no run (DIM-FR-12, DIM-FR-29)", async () => {
    expect(await postRecords(sk12, "orders", { records: orders(1001) })).toMatchObject({ status: 422, body: { error: "too_many_records" } });
    expect(mockStore.runs.size).toBe(0);
    expect(mockPuts).toHaveLength(0);
  });

  it("answers 413 for a 6 MiB body and creates no run (DIM-FR-29)", async () => {
    const body = JSON.stringify({ records: [{ order_id: "o-1", note: "x".repeat(6 * MiB) }] });

    expect((await postRecords(sk12, "orders", body)).status).toBe(413);
    expect(mockStore.runs.size).toBe(0);
  });

  it.each([
    ["not JSON", "records: []"],
    ["without a records list", { rows: [] }],
    ["with an empty records list", { records: [] }],
    ["with a record that is not an object", { records: [1] }],
  ])("answers 400 for a body %s (DIM-FR-29)", async (_case, body) => {
    expect((await postRecords(sk12, "orders", body)).status).toBe(400);
    expect(mockStore.runs.size).toBe(0);
  });

  it("answers 409 snapshot_type for a snapshot type and creates no run (DIM-FR-12)", async () => {
    expect(await postRecords(sk12, "customers", { records: orders(1) })).toMatchObject({ status: 409, body: { error: "snapshot_type" } });
    expect(mockStore.runs.size).toBe(0);
    expect(mockPuts).toHaveLength(0);
  });

  it("answers 403 for a key without the dataset's scope, and 404 for a dataset that does not exist", async () => {
    expect((await postRecords(unscopedKey, "orders", { records: orders(1) })).status).toBe(403);
    expect((await postRecords(sk12, "refunds", { records: orders(1) })).status).toBe(404);
    expect(mockStore.runs.size).toBe(0);
  });

  it("refuses a revoked key with 401", async () => {
    expect((await postRecords(revokedKey, "orders", { records: orders(1) })).status).toBe(401);
  });
});

describe("logs (DIM-NFR-06)", () => {
  it("hold no source key, customer key, or row value, even when storing fails", async () => {
    const failing = jest.spyOn(mockDropZone, "put").mockRejectedValue(new Error("S3 unavailable"));
    expect((await postRecords(sk12, "orders", { records: orders(2) })).status).toBe(503);
    failing.mockRestore();
    await postRecords(sk12, "orders", { records: orders(2) });
    const runId = await uploaded({ byteSize: 1, sha256: SHA });
    await complete(sk12, runId);
    await create(revokedKey);

    expect(logged.length).toBeGreaterThan(0);
    const text = logged.join("\n");
    for (const secret of [sk12, revokedKey, "c-0", "c-1", "o-0", "1450000"]) expect(text).not.toContain(secret);
  });
});
