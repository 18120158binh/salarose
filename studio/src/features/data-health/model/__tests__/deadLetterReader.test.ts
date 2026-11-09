/** @jest-environment node */
import { deadLetter, fakeKafka, partitionOf, type FakeKafka, type Partition } from "../__fakes__/fakeKafka";
import { createDeadLetterReader, DeadLetterReadError, READ_CAP, type DeadLetterReader } from "../deadLetterReader";

const NOW = Date.UTC(2026, 10, 7, 10, 41, 7);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PREFIX = "studio-dead-letters-";

function eventLetter(i: number, reason = "no_timestamp"): string {
  return deadLetter({ record: "event", reason, detail: "dtm", dropped_at: NOW - i, payload_id: "3f9a00c1", event: { eid: `e-${i}` } });
}

function setup(log: Map<number, Partition>, behavior: Parameters<typeof fakeKafka>[1] = {}, now = () => NOW): { kafka: FakeKafka; reader: DeadLetterReader } {
  const kafka = fakeKafka(log, behavior);
  let suffix = 0;
  const reader = createDeadLetterReader({
    topic: "dl",
    groupPrefix: PREFIX,
    admin: async () => kafka.admin,
    consumer: kafka.newConsumer,
    groupSuffix: () => `read-${++suffix}`,
    now,
    readTimeoutMs: 2_000,
  });
  return { kafka, reader };
}

function groupIds(kafka: FakeKafka): string[] {
  return kafka.newConsumer.mock.calls.map(([groupId]) => groupId);
}

describe("dead-letter reader", () => {
  it("gives every read its own group under the prefix, commits nothing, and deletes the group (DHL-FR-08)", async () => {
    const values = Array.from({ length: 150 }, (_, i) => eventLetter(i));
    const { kafka, reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]));

    const first = await reader.readPage({ windowMs: DAY });
    await reader.readPage({ windowMs: DAY, cursor: first.older! });
    await reader.readContent(0, 7);

    const ids = groupIds(kafka);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id.startsWith(PREFIX)).toBe(true);
    for (const consumer of kafka.consumers) {
      expect(consumer.runOptions?.autoCommit).toBe(false);
      expect(consumer.commitOffsets).not.toHaveBeenCalled();
      expect(consumer.disconnected).toBe(true);
    }
    expect(kafka.admin.deleteGroups.mock.calls).toEqual(ids.map((id) => [[id]]));
  });

  it("deletes the group after a read that fails", async () => {
    const { kafka, reader } = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]), { failConnect: new Error("boom") });

    await expect(reader.readPage({ windowMs: DAY })).rejects.toThrow(DeadLetterReadError);

    expect(kafka.admin.deleteGroups).toHaveBeenCalledWith([groupIds(kafka)[0]]);
  });

  it("deletes the group after a read that crashes or times out", async () => {
    const crashing = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]), { stall: true });
    const page = crashing.reader.readPage({ windowMs: DAY });
    await new Promise((resolve) => setTimeout(resolve, 20));
    crashing.kafka.consumers[0].crash(new Error("rebalance failed"));
    await expect(page).rejects.toMatchObject({ reason: "read failed" });
    expect(crashing.kafka.admin.deleteGroups).toHaveBeenCalledWith([groupIds(crashing.kafka)[0]]);

    const stalled = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]), { stall: true });
    await expect(stalled.reader.readPage({ windowMs: DAY })).rejects.toMatchObject({ reason: "timed out" });
    expect(stalled.kafka.admin.deleteGroups).toHaveBeenCalledWith([groupIds(stalled.kafka)[0]]);
  });

  it("bounds the whole read, the connect included, and still deletes the group", async () => {
    const { kafka, reader } = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]), { hangConnect: true });

    await expect(reader.readPage({ windowMs: DAY })).rejects.toMatchObject({ reason: "timed out" });
    await expect(reader.readContent(0, 0)).rejects.toMatchObject({ reason: "timed out" });

    expect(kafka.admin.deleteGroups.mock.calls).toEqual(groupIds(kafka).map((id) => [[id]]));
  });

  it.each(["connect", "run"] as const)(
    "leaves no consumer connected or in the group when %s finishes after the deadline (DHL-FR-08)",
    async (step) => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => (finish = resolve));
      const { kafka, reader } = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]), step === "connect" ? { connectGate: gate } : { runGate: gate });

      await expect(reader.readPage({ windowMs: DAY })).rejects.toMatchObject({ reason: "timed out" });
      finish();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const consumer = kafka.consumers[0];
      expect(consumer.connected).toBe(false);
      expect(consumer.member).toBe(false);
      if (step === "connect") expect(consumer.run).not.toHaveBeenCalled();
      const lastDisconnect = Math.max(...consumer.disconnect.mock.invocationCallOrder);
      expect(Math.max(...kafka.admin.deleteGroups.mock.invocationCallOrder)).toBeGreaterThan(lastDisconnect);
      expect(kafka.admin.deleteGroups).toHaveBeenLastCalledWith([groupIds(kafka)[0]]);
    },
  );

  it("bounds the offset reads that come before the group", async () => {
    const { kafka, reader } = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]));
    kafka.admin.fetchTopicOffsets.mockImplementation(() => new Promise(() => undefined));

    await expect(reader.readPage({ windowMs: DAY })).rejects.toMatchObject({ reason: "timed out" });
    await expect(reader.readContent(0, 0)).rejects.toMatchObject({ reason: "timed out" });
    expect(kafka.newConsumer).not.toHaveBeenCalled();
  });

  it("does not warn when the broker already removed the empty group", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { kafka, reader } = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]));
    kafka.admin.deleteGroups.mockRejectedValue(
      Object.assign(new Error("Error in DeleteGroups"), { name: "KafkaJSDeleteGroupsError", groups: [{ groupId: "x", errorCode: 69, error: { type: "GROUP_ID_NOT_FOUND" } }] }),
    );

    await reader.readPage({ windowMs: DAY });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("shows the newest 100 of 150, then the other 50 (DHL-FR-06)", async () => {
    const values = Array.from({ length: 150 }, (_, i) => eventLetter(i));
    const { reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]));

    const first = await reader.readPage({ windowMs: DAY });
    expect(first.rows.map((r) => r.offset)).toEqual(Array.from({ length: 100 }, (_, i) => 149 - i));
    expect(first.stoppedAtCap).toBe(false);

    const second = await reader.readPage({ windowMs: DAY, cursor: first.older! });
    expect(second.rows.map((r) => r.offset)).toEqual(Array.from({ length: 50 }, (_, i) => 49 - i));
    expect(second.older).toBeNull();
  });

  it("reads only the chosen window", async () => {
    // One record a minute for two hours: the last hour holds 60.
    const values = Array.from({ length: 120 }, (_, i) => eventLetter(i));
    const { reader } = setup(new Map([[0, partitionOf(values, NOW - 30_000, 60_000)]]));

    const page = await reader.readPage({ windowMs: HOUR });

    expect(page.rows).toHaveLength(60);
    expect(page.rows.every((r) => r.timestamp >= NOW - HOUR)).toBe(true);
    expect(page.older).toBeNull();
  });

  it("orders rows newest first across partitions by Kafka timestamp", async () => {
    const even = partitionOf([eventLetter(0), eventLetter(2), eventLetter(4)], NOW - 1_000, 2_000);
    const odd = partitionOf([eventLetter(1), eventLetter(3), eventLetter(5)], NOW - 2_000, 2_000);
    const { reader } = setup(new Map([[0, even], [1, odd]]));

    const page = await reader.readPage({ windowMs: DAY });

    const times = page.rows.map((r) => r.timestamp);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(page.rows.map((r) => r.partition)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("keeps only rows that match the reason filter", async () => {
    const values = Array.from({ length: 300 }, (_, i) => eventLetter(i, i % 3 === 0 ? "schema_invalid" : "no_timestamp"));
    const { reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]));

    const page = await reader.readPage({ windowMs: DAY, filter: { reason: "schema_invalid" } });

    expect(page.rows).toHaveLength(100);
    expect(page.rows.every((r) => r.record === "event" && r.reason === "schema_invalid")).toBe(true);
    expect(page.older).toBeNull();
  });

  it("filters by record type, and a null reason finds the grouping payload records", async () => {
    const values = [
      deadLetter({ record: "payload", reason: null, dropped_at: NOW, payload_id: "3f9a", payload: "AAAA", payload_size: 18_000, payload_truncated: false }),
      eventLetter(1),
      deadLetter({ record: "payload", reason: "payload_not_decoded", dropped_at: NOW, payload: "AAAA", payload_size: 3, payload_truncated: false }),
    ];
    const { reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]));

    const payloads = await reader.readPage({ windowMs: DAY, filter: { record: "payload" } });
    expect(payloads.rows.map((r) => r.offset)).toEqual([2, 0]);

    const grouped = await reader.readPage({ windowMs: DAY, filter: { reason: null } });
    expect(grouped.rows).toEqual([
      expect.objectContaining({ offset: 0, record: "payload", reason: null, payloadSize: 18_000, payloadTruncated: false }),
    ]);
  });

  it("reads at most 10,000 of 20,000 records, shows the newest matches, and says it stopped (DHL-NFR-02)", async () => {
    // Only the oldest 50 and 5 of the newest 10,000 match the filter.
    const values = Array.from({ length: 20_000 }, (_, i) =>
      eventLetter(i, i < 50 || (i >= 15_000 && i < 15_005) ? "schema_invalid" : "no_timestamp"),
    );
    const { kafka, reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000, 1)]]), { batchSize: 2_000 });

    const page = await reader.readPage({ windowMs: DAY, filter: { reason: "schema_invalid" } });

    expect(page.stoppedAtCap).toBe(true);
    expect(page.rows.map((r) => r.offset)).toEqual([15_004, 15_003, 15_002, 15_001, 15_000]);
    const lowestSeek = Math.min(...kafka.consumers[0].seeks.map((s) => s.offset));
    expect(20_000 - lowestSeek).toBeLessThanOrEqual(READ_CAP);
    expect(page.older).not.toBeNull();
  });

  it("ignores a batch fetched before the latest seek", async () => {
    // Every 7th record matches, so the page reads three chunks, and a stale batch arrives before each later one.
    const values = Array.from({ length: 700 }, (_, i) => eventLetter(i, i % 7 === 0 ? "schema_invalid" : "no_timestamp"));
    const { kafka, reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]), { batchSize: 70, prefetch: true });

    const page = await reader.readPage({ windowMs: DAY, filter: { reason: "schema_invalid" } });

    expect(kafka.consumers[0].seeks.length).toBeGreaterThanOrEqual(3);
    expect(page.rows.map((r) => r.offset)).toEqual(Array.from({ length: 100 }, (_, i) => 693 - 7 * i));
  });

  it("keeps an unreadable record as a row with its partition and offset", async () => {
    const values = [eventLetter(0), "not json", deadLetter({ reason: "no_timestamp" }), null, eventLetter(4)];
    const { reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]));

    const page = await reader.readPage({ windowMs: DAY });

    expect(page.rows.map((r) => r.record)).toEqual(["event", "unreadable", "unreadable", "unreadable", "event"]);
    expect(page.rows[1]).toEqual({ partition: 0, offset: 3, timestamp: expect.any(Number), record: "unreadable" });
  });

  it("steps over transaction markers", async () => {
    const partition = partitionOf(Array.from({ length: 12 }, (_, i) => eventLetter(i)), NOW - 1_000);
    for (const offset of [5, 11]) partition.records[offset].marker = true;
    const { reader } = setup(new Map([[0, partition]]));

    const page = await reader.readPage({ windowMs: DAY });

    expect(page.rows.map((r) => r.offset)).toEqual([10, 9, 8, 7, 6, 4, 3, 2, 1, 0]);
    expect(page.older).toBeNull();
  });

  it("lists rows without their content (DHL-FR-07)", async () => {
    const { reader } = setup(new Map([[0, partitionOf([eventLetter(0)], NOW - 1_000)]]));

    const page = await reader.readPage({ windowMs: DAY });

    expect(JSON.stringify(page)).not.toContain("e-0");
  });

  it("returns one record's content, and null for a position that holds none", async () => {
    const values = [
      eventLetter(0),
      deadLetter({ record: "payload", reason: "payload_not_decoded", payload: "AQID", payload_size: 3, payload_truncated: false }),
    ];
    const { kafka, reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]));

    await expect(reader.readContent(0, 0)).resolves.toEqual({ record: "event", event: { eid: "e-0" } });
    await expect(reader.readContent(0, 1)).resolves.toEqual({ record: "payload", payload: "AQID", payloadSize: 3, payloadTruncated: false });
    await expect(reader.readContent(0, 2)).resolves.toBeNull();
    await expect(reader.readContent(3, 0)).resolves.toBeNull();
    expect(kafka.newConsumer).toHaveBeenCalledTimes(2);
  });

  it("logs no record content (DHL-FR-09)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => undefined));
    const secret = "0912345678";
    const values = [
      deadLetter({ record: "event", reason: "schema_invalid", event: { user_id: secret } }),
      `{"record":"event","event":{"user_id":"${secret}"`,
    ];
    const { kafka, reader } = setup(new Map([[0, partitionOf(values, NOW - 1_000)]]));
    kafka.admin.deleteGroups.mockRejectedValue(new Error("coordinator gone"));

    await reader.readPage({ windowMs: DAY });
    await reader.readContent(0, 0);
    await reader.readContent(0, 1);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(secret);
    expect(spies[2]).toHaveBeenCalled();
    spies.forEach((spy) => spy.mockRestore());
  });

  it("names the reason a read failed", async () => {
    const { kafka, reader } = setup(new Map([[0, partitionOf([], NOW)]]));
    kafka.admin.fetchTopicOffsets.mockRejectedValue(
      Object.assign(new Error("retries exceeded"), { name: "KafkaJSNumberOfRetriesExceeded", originalError: { type: "UNKNOWN_TOPIC_OR_PARTITION" } }),
    );
    await expect(reader.readPage({ windowMs: DAY })).rejects.toMatchObject({ reason: "topic not found" });

    const denied = setup(new Map([[0, partitionOf([], NOW)]]));
    denied.kafka.admin.fetchTopicOffsets.mockRejectedValue({ type: "TOPIC_AUTHORIZATION_FAILED" });
    await expect(denied.reader.readContent(0, 0)).rejects.toMatchObject({ reason: "not authorized" });
  });

  it("reads an empty window without a consumer group", async () => {
    const { kafka, reader } = setup(new Map([[0, partitionOf([], NOW)]]));

    await expect(reader.readPage({ windowMs: DAY })).resolves.toEqual({ rows: [], older: null, stoppedAtCap: false });
    expect(kafka.newConsumer).not.toHaveBeenCalled();
  });
});

describe("dropped-record count", () => {
  it("counts the records in the window from offsets, without a consumer group (HOM-FR-08)", async () => {
    const values = Array.from({ length: 10 }, (_, i) => eventLetter(i));
    const { kafka, reader } = setup(new Map([[0, partitionOf(values, NOW - 30_000, 10 * 60_000)]]));

    await expect(reader.droppedCount(HOUR)).resolves.toBe(6);
    expect(kafka.newConsumer).not.toHaveBeenCalled();
  });

  it("reads the offsets once for 20 viewers within 15 seconds (HOM-NFR-03)", async () => {
    let now = NOW;
    const { kafka, reader } = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]), {}, () => now);

    await Promise.all(Array.from({ length: 20 }, () => reader.droppedCount(HOUR)));
    now += 14_999;
    await reader.droppedCount(HOUR);
    expect(kafka.admin.fetchTopicOffsets).toHaveBeenCalledTimes(1);

    now += 1;
    await reader.droppedCount(HOUR);
    expect(kafka.admin.fetchTopicOffsets).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a failed offsets read, so the next request tries again", async () => {
    const { kafka, reader } = setup(new Map([[0, partitionOf([eventLetter(1)], NOW)]]));
    kafka.admin.fetchTopicOffsets.mockRejectedValueOnce(Object.assign(new Error("down"), { name: "KafkaJSConnectionError" }));

    await expect(reader.droppedCount(HOUR)).rejects.toMatchObject({ reason: "Kafka unreachable" });
    await expect(reader.droppedCount(HOUR)).resolves.toBe(1);
    expect(kafka.admin.fetchTopicOffsets).toHaveBeenCalledTimes(2);
  });
});

describe("retention", () => {
  it("reads retention.ms from the topic (DHL-FR-11)", async () => {
    const { kafka, reader } = setup(new Map(), { retentionMs: "604800000" });

    await expect(reader.retention()).resolves.toEqual({ kind: "bounded", ms: 7 * DAY });
    expect(kafka.admin.describeConfigs).toHaveBeenCalledWith(
      expect.objectContaining({ resources: [expect.objectContaining({ name: "dl", configNames: ["retention.ms"] })] }),
    );
  });

  it("is unknown when the configuration cannot be read", async () => {
    const { kafka, reader } = setup(new Map());
    kafka.admin.describeConfigs.mockRejectedValue(new Error("not authorized"));

    await expect(reader.retention()).resolves.toEqual({ kind: "unknown" });
  });
});
