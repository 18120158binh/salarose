/**
 * @jest-environment node
 */
import * as db from "@/lib/db";
import { publishBusinessEvents } from "../../../../src/features/data-ingestion/model/businessEventProducer";
import { hashSourceKey } from "../../../../src/features/data-ingestion/model/sourceKeys";
import { POST } from "../route";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/db", () => ({ findSourceKeyByHash: jest.fn(), getCatalogEventKinds: jest.fn() }));
jest.mock("../../../../src/features/data-ingestion/model/businessEventProducer", () => ({
  ...jest.requireActual("../../../../src/features/data-ingestion/model/businessEventProducer"),
  publishBusinessEvents: jest.fn(),
}));

const KEY = "cdp_sk_valid";
const REVOKED_KEY = "cdp_sk_revoked";

const priceDrop = {
  event_id: "0f8b2c1e-5d4a-4c3b-9a21-7e6f5d4c3b2a",
  event_name: "price_drop",
  event_time: "2026-10-21T09:00:00Z",
  attributes: { product: { id: "SKU-123", price: 899000 }, drop_percent: 15 },
};

// Each test gets a source key of its own, because the rate limit lives for the whole file.
let keyNumber = 0;
let key = KEY;

beforeEach(() => {
  jest.mocked(publishBusinessEvents).mockReset().mockResolvedValue();
  process.env.INGESTION_KAFKA_BROKERS = "kafka:9092";
  delete process.env.INGESTION_RATE_LIMIT_PER_SECOND;
  key = `${KEY}_${++keyNumber}`;
  const stored = new Map([
    [hashSourceKey(key), { id: "sk_1", appId: "inventory-service", revoked: false }],
    [hashSourceKey(REVOKED_KEY), { id: "sk_0", appId: "old-service", revoked: true }],
  ]);
  jest.mocked(db.findSourceKeyByHash).mockImplementation(async (hash) => stored.get(hash) ?? null);
  jest.mocked(db.getCatalogEventKinds).mockResolvedValue(
    new Map([
      ["price_drop", { kind: "business", itemKey: "product.id" }],
      ["add_to_cart", { kind: "person" }],
    ]),
  );
});

async function post(body: unknown, authorization: string | null = `Bearer ${key}`) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;
  const response = await POST(
    new Request("https://studio.test/v1/business-events", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: response.status, retryAfter: response.headers.get("Retry-After"), body: await response.json() };
}

function published() {
  return jest.mocked(publishBusinessEvents).mock.calls.flatMap(([, records]) => records);
}

describe("POST /v1/business-events", () => {
  it("accepts the price drop and writes it keyed by event name and item key", async () => {
    const result = await post({ events: [priceDrop] });

    expect(result).toEqual({ status: 200, retryAfter: null, body: { accepted: 1, rejected: [] } });
    expect(published()).toEqual([
      {
        schema_version: 1,
        event_id: priceDrop.event_id,
        event_name: "price_drop",
        event_time: 1792573200000,
        item_key: "SKU-123",
        app_id: "inventory-service",
        attributes: priceDrop.attributes,
      },
    ]);
    expect(jest.mocked(publishBusinessEvents).mock.calls[0][0].businessTopic).toBe("business-events");
  });

  it("refuses a request without a key with 401 and writes nothing", async () => {
    const result = await post({ events: [priceDrop] }, null);

    expect(result.status).toBe(401);
    expect(publishBusinessEvents).not.toHaveBeenCalled();
  });

  it("refuses an unknown key and a revoked key with 401 and writes nothing", async () => {
    expect((await post({ events: [priceDrop] }, "Bearer cdp_sk_unknown")).status).toBe(401);
    expect((await post({ events: [priceDrop] }, `Bearer ${REVOKED_KEY}`)).status).toBe(401);
    expect(publishBusinessEvents).not.toHaveBeenCalled();
  });

  it("rejects a business event without its item key, naming the item key, and accepts the rest", async () => {
    const noItem = { ...priceDrop, event_id: "1f8b2c1e-5d4a-4c3b-9a21-7e6f5d4c3b2a", attributes: { drop_percent: 15 } };

    const result = await post({ events: [noItem, priceDrop] });

    expect(result.body).toEqual({
      accepted: 1,
      rejected: [{ index: 0, event_id: noItem.event_id, reason: "the item key product.id is missing from attributes" }],
    });
    expect(published().map((r) => r.event_id)).toEqual([priceDrop.event_id]);
  });

  it("rejects a business event with a user_id", async () => {
    const result = await post({ events: [{ ...priceDrop, user_id: "u1" }] });

    expect(result.body.rejected).toEqual([
      { index: 0, event_id: priceDrop.event_id, reason: "a business event must not carry user_id or anonymous_id" },
    ]);
    expect(publishBusinessEvents).not.toHaveBeenCalled();
  });

  it("rejects a person event and names the person route", async () => {
    const result = await post({ events: [{ ...priceDrop, event_name: "add_to_cart" }] });

    expect(result.body.rejected[0].reason).toBe("add_to_cart is a person event. Post it to /v1/events.");
  });

  it("answers 413 for 501 events and writes nothing", async () => {
    const events = Array.from({ length: 501 }, () => priceDrop);

    expect((await post({ events })).status).toBe(413);
    expect(publishBusinessEvents).not.toHaveBeenCalled();
  });

  it("accepts 500 events", async () => {
    const events = Array.from({ length: 500 }, () => priceDrop);

    expect((await post({ events })).body.accepted).toBe(500);
  });

  it("answers 413 for a body over 1 MiB", async () => {
    const big = { ...priceDrop, attributes: { ...priceDrop.attributes, note: "x".repeat(1024 * 1024) } };

    expect((await post({ events: [big] })).status).toBe(413);
  });

  it("answers 413 for a streamed body over 1 MiB with no content-length, without reading it all", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://studio.test/v1/business-events", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(40);
    expect(publishBusinessEvents).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON or has no events list", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ items: [] })).status).toBe(400);
  });

  it("answers 429 with Retry-After over the key's rate limit", async () => {
    process.env.INGESTION_RATE_LIMIT_PER_SECOND = "2";

    await post({ events: [priceDrop] });
    await post({ events: [priceDrop] });
    const third = await post({ events: [priceDrop] });

    expect(third.status).toBe(429);
    expect(third.retryAfter).toBe("1");
  });

  it("answers 503 when Kafka refuses the batch", async () => {
    jest.mocked(publishBusinessEvents).mockRejectedValue(new Error("broker down"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await post({ events: [priceDrop] })).status).toBe(503);
  });

  it("never logs the source key", async () => {
    jest.mocked(publishBusinessEvents).mockRejectedValue(new Error("broker down"));
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await post({ events: [priceDrop] });

    expect(JSON.stringify(error.mock.calls)).not.toContain(key);
  });
});
