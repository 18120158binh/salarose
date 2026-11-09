/** @jest-environment node */
import type { TimeZone } from "@/shared/lib/time-range";
import { parseCursor, parseDeadLetterQuery, parsePosition, queryHref, querySearch, toFilter, windowMs, type DeadLetterQuery } from "../deadLetterQuery";
import { failureMessage, payloadSizeText, retentionSentence, shortPayloadId } from "../deadLetterView";

function parse(params: Record<string, string>): DeadLetterQuery | undefined {
  return parseDeadLetterQuery((name) => params[name]);
}

describe("browser address", () => {
  it("defaults to the shell's default range with no filter, and writes no defaults back", () => {
    const query = parse({})!;

    expect(query).toEqual({ window: "7d", reason: null, record: null });
    expect(querySearch(query)).toBe("");
  });

  it("reads back every query it writes", () => {
    const query: DeadLetterQuery = { window: "30d", reason: "grouped", record: "payload" };

    expect(parse(Object.fromEntries(new URLSearchParams(querySearch(query))))).toEqual(query);
  });

  it("refuses a window, reason, or record type the page does not offer", () => {
    expect(parse({ window: "24h" })).toBeUndefined();
    expect(parse({ reason: "SCHEMA_INVALID" })).toBeUndefined();
    expect(parse({ record: "unreadable" })).toBeUndefined();
  });

  it("filters (grouped) as the payload records with a null reason", () => {
    expect(toFilter({ window: "today", reason: "grouped", record: null })).toEqual({ reason: null });
    expect(toFilter({ window: "today", reason: "schema_invalid", record: "event" })).toEqual({ reason: "schema_invalid", record: "event" });
    expect(toFilter({ window: "today", reason: null, record: null })).toEqual({});
  });
});

describe("window", () => {
  const NOW = Date.UTC(2026, 10, 8, 10, 0);
  const HOUR = 3_600_000;

  it("reaches back to the viewer's midnight, and to the shell's range start", () => {
    expect(windowMs("today", "UTC" as TimeZone, NOW)).toBe(10 * HOUR);
    expect(windowMs("today", "Asia/Ho_Chi_Minh" as TimeZone, NOW)).toBe(17 * HOUR);
    expect(windowMs("7d", "UTC" as TimeZone, NOW)).toBe(6 * 24 * HOUR + 10 * HOUR);
  });
});

describe("page address", () => {
  it("merges the query into the page's own parameters", () => {
    const query: DeadLetterQuery = { window: "today", reason: "schema_invalid", record: null };

    expect(queryHref("/v2/data/monitoring?tab=dropped", query)).toBe("/v2/data/monitoring?tab=dropped&window=today&reason=schema_invalid");
    expect(queryHref("/v2/data/dead-letters", { ...query, window: "7d", reason: null })).toBe("/v2/data/dead-letters");
  });
});

describe("older cursor", () => {
  it("accepts the cursor the reader made", () => {
    const cursor = { partitions: [{ partition: 0, start: 0, before: 50 }, { partition: 1, start: 4, before: 4 }] };

    expect(parseCursor(JSON.stringify(cursor))).toEqual(cursor);
  });

  it.each([
    ["not JSON", "{"],
    ["no partitions", "{}"],
    ["a start after its end", JSON.stringify({ partitions: [{ partition: 0, start: 9, before: 3 }] })],
    ["a fraction", JSON.stringify({ partitions: [{ partition: 0, start: 0.5, before: 3 }] })],
    ["a partition twice", JSON.stringify({ partitions: [{ partition: 0, start: 0, before: 3 }, { partition: 0, start: 0, before: 3 }] })],
    ["too many partitions", JSON.stringify({ partitions: Array.from({ length: 1_001 }, (_, partition) => ({ partition, start: 0, before: 1 })) })],
  ])("refuses %s", (_case, value) => {
    expect(parseCursor(value)).toBeUndefined();
  });
});

describe("record position", () => {
  it("reads whole non-negative numbers only", () => {
    expect(parsePosition("2", "41")).toEqual({ partition: 2, offset: 41 });
    expect(parsePosition("2", null)).toBeUndefined();
    expect(parsePosition("-1", "4")).toBeUndefined();
    expect(parsePosition("1", "4.5")).toBeUndefined();
  });
});

describe("what a row and the page say", () => {
  it("says that records are kept for 7 days on a topic with 7-day retention (DHL-FR-11)", () => {
    expect(retentionSentence({ kind: "bounded", ms: 7 * 86_400_000 })).toBe("Kept for 7 days by the topic. Older records are gone.");
    expect(retentionSentence({ kind: "bounded", ms: 3_600_000 })).toBe("Kept for 1 hour by the topic. Older records are gone.");
    expect(retentionSentence({ kind: "unlimited" })).toBe("Kept without a time limit by the topic.");
    expect(retentionSentence({ kind: "unknown" })).toBe("The topic's retention is unknown.");
  });

  it("shows the first and last characters of a payload id", () => {
    expect(shortPayloadId("3f9a07be55c1")).toBe("3f9a…c1");
    expect(shortPayloadId("3f9a")).toBe("3f9a");
  });

  it("shows a payload record's size and whether it was cut", () => {
    const payload = { partition: 0, offset: 1, timestamp: 1, reason: null, detail: null, droppedAt: 1, payloadId: "p", record: "payload" as const };

    expect(payloadSizeText({ ...payload, payloadSize: 18_432, payloadTruncated: false })).toBe("18 KB");
    expect(payloadSizeText({ ...payload, payloadSize: 524_288, payloadTruncated: true })).toBe("512 KB, cut");
    expect(payloadSizeText({ partition: 0, offset: 1, timestamp: 1, record: "unreadable" })).toBeNull();
  });

  it("names only a known failure reason, never other server text", () => {
    expect(failureMessage(503, { error: "not authorized" })).toBe("Dropped data could not load: not authorized.");
    expect(failureMessage(500, { error: "secret stack trace" })).toBe("Dropped data could not load.");
    expect(failureMessage(403, null)).toBe("This page is for admins.");
  });
});
