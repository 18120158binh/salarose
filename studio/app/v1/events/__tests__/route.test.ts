/**
 * @jest-environment node
 */
import * as db from "@/lib/db";
import { publishPersonEvents } from "../../../../src/features/data-ingestion/model/businessEventProducer";
import { hashSourceKey } from "../../../../src/features/data-ingestion/model/sourceKeys";
import { POST } from "../route";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/db", () => ({ findSourceKeyByHash: jest.fn(), getCatalogEventKinds: jest.fn() }));
jest.mock("../../../../src/features/data-ingestion/model/businessEventProducer", () => ({
  ...jest.requireActual("../../../../src/features/data-ingestion/model/businessEventProducer"),
  publishPersonEvents: jest.fn(),
}));

const KEY = "cdp_sk_valid";
const REVOKED_KEY = "cdp_sk_revoked";

// The purchase of the contract's Behavior section.
const purchase = {
  event_id: "6b0c8f3e-1d2a-4c55-9a77-1f0e2d3c4b5a",
  event_name: "com.acme/purchase",
  event_time: "2026-10-18T09:13:02.120Z",
  user_id: "0912345678",
  attributes: { order: { id: "SO-1001", total: 12990000 } },
};

// Each test gets a source key of its own, because the rate limit lives for the whole file.
let keyNumber = 0;
let key = KEY;

beforeEach(() => {
  jest.mocked(publishPersonEvents).mockReset().mockResolvedValue();
  process.env.INGESTION_KAFKA_BROKERS = "kafka:9092";
  delete process.env.INGESTION_RATE_LIMIT_PER_SECOND;
  key = `${KEY}_${++keyNumber}`;
  const stored = new Map([
    [hashSourceKey(key), { id: "sk_1", appId: "order-service", revoked: false }],
    [hashSourceKey(REVOKED_KEY), { id: "sk_0", appId: "old-service", revoked: true }],
  ]);
  jest.mocked(db.findSourceKeyByHash).mockImplementation(async (hash) => stored.get(hash) ?? null);
  jest.mocked(db.getCatalogEventKinds).mockResolvedValue(
    new Map([
      ["com.acme/price_drop", { kind: "business", itemKey: "product.id" }],
      ["com.acme/purchase", { kind: "person" }],
    ]),
  );
});

async function post(body: unknown, authorization: string | null = `Bearer ${key}`) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;
  const response = await POST(
    new Request("https://studio.test/v1/events", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

function published() {
  return jest.mocked(publishPersonEvents).mock.calls.flatMap(([, records]) => records);
}

async function rejection(event: Record<string, unknown>) {
  const result = await post({ events: [event] });
  expect(result.status).toBe(200);
  expect(publishPersonEvents).not.toHaveBeenCalled();
  return result.body.rejected[0].reason;
}

describe("POST /v1/events", () => {
  it("accepts the contract's batch, rejects the bad id, and writes the purchase with the source's app id", async () => {
    const result = await post({
      events: [purchase, { event_id: "not-a-uuid", event_name: "com.acme/purchase", event_time: "2026-10-18T09:14:00Z" }],
    });

    expect(result).toEqual({
      status: 200,
      body: { accepted: 1, rejected: [{ index: 1, event_id: "not-a-uuid", reason: "event_id must be a UUID" }] },
    });
    expect(published()).toEqual([
      {
        schema_version: 1,
        event_id: purchase.event_id,
        event_name: "com.acme/purchase",
        event_time: Date.parse(purchase.event_time),
        user_id: "0912345678",
        anonymous_id: null,
        app_id: "order-service",
        attributes: purchase.attributes,
      },
    ]);
    expect(jest.mocked(publishPersonEvents).mock.calls[0][0].eventsTopic).toBe("ingestion-api-events");
  });

  it("refuses a request without a key, or with an unknown or revoked key, with 401 and writes nothing", async () => {
    expect((await post({ events: [purchase] }, null)).status).toBe(401);
    expect((await post({ events: [purchase] }, "Bearer cdp_sk_unknown")).status).toBe(401);
    expect((await post({ events: [purchase] }, `Bearer ${REVOKED_KEY}`)).status).toBe(401);
    expect(publishPersonEvents).not.toHaveBeenCalled();
  });

  it("rejects an event without its id, name, or time", async () => {
    expect(await rejection({ ...purchase, event_id: undefined })).toBe("event_id must be a UUID");
    expect(await rejection({ ...purchase, event_name: " " })).toBe("event_name must be non-empty text");
    expect(await rejection({ ...purchase, event_time: undefined })).toBe(
      "event_time must be ISO 8601 with a zone, or epoch milliseconds",
    );
  });

  it("rejects a time without a zone", async () => {
    expect(await rejection({ ...purchase, event_time: "2026-10-18T09:13:02" })).toBe(
      "event_time must be ISO 8601 with a zone, or epoch milliseconds",
    );
  });

  it("rejects an event with neither user_id nor anonymous_id", async () => {
    expect(await rejection({ ...purchase, user_id: undefined })).toBe("user_id or anonymous_id is required");
    expect(await rejection({ ...purchase, user_id: "  " })).toBe("user_id or anonymous_id is required");
  });

  it("rejects attributes that are not a JSON object", async () => {
    expect(await rejection({ ...purchase, attributes: [1, 2] })).toBe("attributes must be a JSON object");
    expect(await rejection({ ...purchase, attributes: "order" })).toBe("attributes must be a JSON object");
  });

  it("rejects a business event and names the business route", async () => {
    expect(await rejection({ ...purchase, event_name: "com.acme/price_drop" })).toBe(
      "com.acme/price_drop is a business event. Post it to /v1/business-events.",
    );
  });

  it("accepts an anonymous event in epoch milliseconds and validates each event on its own", async () => {
    const anonymous = { ...purchase, user_id: undefined, anonymous_id: "a1b2c3", event_time: 1792314782120 };

    const result = await post({ events: [anonymous, "not an event", { ...purchase, user_id: 42 }] });

    expect(result.body).toEqual({
      accepted: 1,
      rejected: [
        { index: 1, reason: "event must be a JSON object" },
        { index: 2, event_id: purchase.event_id, reason: "user_id must be text" },
      ],
    });
    expect(published()).toMatchObject([{ user_id: null, anonymous_id: "a1b2c3", event_time: 1792314782120 }]);
  });

  it("answers 503 and stores nothing when Kafka refuses the batch", async () => {
    jest.mocked(publishPersonEvents).mockRejectedValue(new Error("broker down"));
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await post({ events: [purchase] })).status).toBe(503);
    expect(JSON.stringify(error.mock.calls)).not.toContain(key);
  });
});
