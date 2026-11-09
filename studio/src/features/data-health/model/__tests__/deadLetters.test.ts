/** @jest-environment node */
import { matchesFilter, parseDeadLetterConfig, parseDeadLetterContent, parseDeadLetterRow, parseRetention } from "../deadLetters";

const at = { partition: 0, offset: 41, timestamp: 1_762_512_067_000 };

describe("parseDeadLetterRow", () => {
  it("reads an event record without its content", () => {
    const value = JSON.stringify({
      record: "event",
      reason: "schema_invalid",
      detail: "product.price not number",
      dropped_at: 1_762_512_067_000,
      payload_id: null,
      event: { user_id: "0912345678" },
      event_name: "add_to_cart",
    });

    expect(parseDeadLetterRow(at, value)).toEqual({
      ...at,
      record: "event",
      reason: "schema_invalid",
      detail: "product.price not number",
      droppedAt: 1_762_512_067_000,
      payloadId: null,
      eventName: "add_to_cart",
    });
  });

  it("reads an event record written before ingestion named dropped events as having no name", () => {
    const value = JSON.stringify({ record: "event", reason: "no_timestamp", event: {} });

    expect(parseDeadLetterRow(at, value)).toEqual(expect.objectContaining({ record: "event", eventName: null }));
  });

  it("reads a payload record's size and cut flag without its bytes", () => {
    const value = JSON.stringify({ record: "payload", reason: null, payload_id: "3f9a", payload: "AAAA", payload_size: 18_432, payload_truncated: true });

    expect(parseDeadLetterRow(at, value)).toEqual({
      ...at,
      record: "payload",
      reason: null,
      detail: null,
      droppedAt: null,
      payloadId: "3f9a",
      payloadSize: 18_432,
      payloadTruncated: true,
    });
  });

  it.each([["not json"], ["[1,2]"], ['"text"'], [JSON.stringify({ reason: "no_timestamp" })], [JSON.stringify({ record: "other" })], [null]])(
    "marks %p unreadable",
    (value) => {
      expect(parseDeadLetterRow(at, value)).toEqual({ ...at, record: "unreadable" });
    },
  );
});

describe("parseDeadLetterContent", () => {
  it("returns the event of an event record and the Base64 of a payload record", () => {
    expect(parseDeadLetterContent(JSON.stringify({ record: "event", event: { eid: "x" } }))).toEqual({ record: "event", event: { eid: "x" } });
    expect(parseDeadLetterContent(JSON.stringify({ record: "payload", payload: "AQID", payload_size: 3, payload_truncated: false }))).toEqual({
      record: "payload",
      payload: "AQID",
      payloadSize: 3,
      payloadTruncated: false,
    });
  });

  it("is unreadable without content", () => {
    expect(parseDeadLetterContent(JSON.stringify({ record: "event" }))).toEqual({ record: "unreadable" });
    expect(parseDeadLetterContent(JSON.stringify({ record: "payload" }))).toEqual({ record: "unreadable" });
    expect(parseDeadLetterContent("{")).toEqual({ record: "unreadable" });
  });
});

describe("matchesFilter", () => {
  const row = parseDeadLetterRow(at, JSON.stringify({ record: "event", reason: "no_timestamp" }));
  const unreadable = parseDeadLetterRow(at, "x");

  it("matches every row without a filter, and no unreadable row with one", () => {
    expect(matchesFilter(unreadable, {})).toBe(true);
    expect(matchesFilter(unreadable, { record: "event" })).toBe(false);
    expect(matchesFilter(row, { reason: "no_timestamp", record: "event" })).toBe(true);
    expect(matchesFilter(row, { reason: "schema_invalid" })).toBe(false);
    expect(matchesFilter(row, { record: "payload" })).toBe(false);
  });

  it("matches an event name only on event records of that name", () => {
    const named = parseDeadLetterRow(at, JSON.stringify({ record: "event", reason: "no_timestamp", event_name: "add_to_cart" }));
    const payload = parseDeadLetterRow(at, JSON.stringify({ record: "payload", reason: null }));

    expect(matchesFilter(named, { eventName: "add_to_cart" })).toBe(true);
    expect(matchesFilter(named, { eventName: "view_page" })).toBe(false);
    expect(matchesFilter(row, { eventName: "add_to_cart" })).toBe(false);
    expect(matchesFilter(payload, { eventName: "add_to_cart" })).toBe(false);
  });
});

describe("parseRetention", () => {
  it.each([
    ["604800000", { kind: "bounded", ms: 604_800_000 }],
    ["-1", { kind: "unlimited" }],
    [undefined, { kind: "unknown" }],
    ["soon", { kind: "unknown" }],
    ["0", { kind: "unknown" }],
  ])("reads %p", (value, expected) => {
    expect(parseRetention(value)).toEqual(expected);
  });
});

describe("parseDeadLetterConfig", () => {
  it("is null without brokers", () => {
    expect(parseDeadLetterConfig({})).toBeNull();
  });

  it("defaults the topic to ingestion's default and the group prefix to studio's", () => {
    expect(parseDeadLetterConfig({ DEAD_LETTER_KAFKA_BROKERS: "a:9092, b:9092" })).toEqual({
      brokers: ["a:9092", "b:9092"],
      ssl: false,
      topic: "snowplow-parsed-dead-letters",
      groupPrefix: "studio-dead-letters-",
    });
  });

  it("reads the topic from ingestion's variable, and SASL settings under its own prefix", () => {
    expect(
      parseDeadLetterConfig({
        DEAD_LETTER_KAFKA_BROKERS: "a:9092",
        KAFKA_EVENT_DEAD_LETTER_TOPIC: "dlq",
        DEAD_LETTER_GROUP_PREFIX: "studio-dl-",
        DEAD_LETTER_KAFKA_SSL: "TRUE",
        DEAD_LETTER_KAFKA_SASL_MECHANISM: "SCRAM-SHA-512",
        DEAD_LETTER_KAFKA_SASL_USERNAME: "studio-dl",
        DEAD_LETTER_KAFKA_SASL_PASSWORD: "pw",
      }),
    ).toEqual({
      brokers: ["a:9092"],
      ssl: true,
      sasl: { mechanism: "scram-sha-512", username: "studio-dl", password: "pw" },
      topic: "dlq",
      groupPrefix: "studio-dl-",
    });
  });

  it("rejects a group prefix outside the ACL-safe characters, and SASL without credentials", () => {
    expect(() => parseDeadLetterConfig({ DEAD_LETTER_KAFKA_BROKERS: "a:9092", DEAD_LETTER_GROUP_PREFIX: "studio dl-" })).toThrow(/DEAD_LETTER_GROUP_PREFIX/);
    expect(() => parseDeadLetterConfig({ DEAD_LETTER_KAFKA_BROKERS: "a:9092", DEAD_LETTER_KAFKA_SASL_MECHANISM: "plain" })).toThrow(
      /DEAD_LETTER_KAFKA_SASL_USERNAME/,
    );
  });

  it("rejects a group prefix that does not end with a dash, so a prefixed ACL cannot match a pipeline group", () => {
    expect(() => parseDeadLetterConfig({ DEAD_LETTER_KAFKA_BROKERS: "a:9092", DEAD_LETTER_GROUP_PREFIX: "event-processor" })).toThrow(
      /end with a dash/,
    );
  });
});
