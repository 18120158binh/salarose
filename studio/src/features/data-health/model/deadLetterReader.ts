import { ConfigResourceTypes, type Admin, type Batch, type Consumer } from "kafkajs";
import {
  matchesFilter,
  parseDeadLetterContent,
  parseDeadLetterRow,
  parseRetention,
  type DeadLetterContent,
  type DeadLetterFilter,
  type DeadLetterRow,
  type Retention,
} from "./deadLetters";

export const OFFSETS_REUSE_MS = 15_000;
export const PAGE_SIZE = 100;
// The most records one page may read (DHL-NFR-02).
export const READ_CAP = 10_000;
// Bounds a whole read: connect, the group join, every fetch, and the read itself.
const READ_TIMEOUT_MS = 8_000;

export type ReaderAdmin = Pick<Admin, "fetchTopicOffsets" | "fetchTopicOffsetsByTimestamp" | "describeConfigs" | "deleteGroups">;
// No commitOffsets, so the reader cannot commit (DHL-FR-08).
export type ReaderConsumer = Pick<Consumer, "connect" | "disconnect" | "subscribe" | "run" | "seek" | "pause" | "resume" | "on" | "events">;

export type DeadLetterFailure = "not configured" | "topic not found" | "not authorized" | "Kafka unreachable" | "timed out" | "read failed";

export class DeadLetterReadError extends Error {
  constructor(readonly reason: DeadLetterFailure) {
    super(`Dead letters could not load: ${reason}`);
    this.name = "DeadLetterReadError";
  }
}

// Where the next older page starts, per partition: offsets from `start` up to `before`, exclusive.
export interface DeadLetterCursor {
  partitions: { partition: number; start: number; before: number }[];
}

export interface DeadLetterPage {
  rows: DeadLetterRow[];
  // Null when the window holds no older record.
  older: DeadLetterCursor | null;
  // The page read READ_CAP records and stopped before it found a full page or the window's start.
  stoppedAtCap: boolean;
}

export interface DeadLetterPageRequest {
  // The window ends now and starts this many milliseconds before.
  windowMs: number;
  filter?: DeadLetterFilter;
  // Omitted for the newest page.
  cursor?: DeadLetterCursor;
}

export interface DeadLetterReader {
  // Records in the window, counted from each partition's offsets, without a consumer group.
  droppedCount(windowMs: number): Promise<number>;
  readPage(request: DeadLetterPageRequest): Promise<DeadLetterPage>;
  // Null when the record is gone, or the position never held one.
  readContent(partition: number, offset: number): Promise<DeadLetterContent | null>;
  retention(): Promise<Retention>;
}

export interface DeadLetterReaderDeps {
  topic: string;
  groupPrefix: string;
  admin: () => Promise<ReaderAdmin>;
  consumer: (groupId: string) => ReaderConsumer;
  groupSuffix: () => string;
  now: () => number;
  readTimeoutMs?: number;
}

interface PartitionWindow {
  partition: number;
  low: number;
  start: number;
  end: number;
}

interface RawRecord {
  offset: number;
  timestamp: number;
  value: string | null;
}

interface Range {
  partition: number;
  from: number;
  to: number;
}

type ReadRanges = (ranges: Range[]) => Promise<Map<number, RawRecord[]>>;

// One partition's part of a page. `buffer` holds the rows read from `readFrom` up to `before`,
// newest first, that the page has not taken yet.
interface Lane {
  partition: number;
  start: number;
  before: number;
  readFrom: number;
  buffer: DeadLetterRow[];
  chunk: number;
}

function toOffset(value: string): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new DeadLetterReadError("read failed");
  return offset;
}

function errorType(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { type, name } = error as { type?: unknown; name?: unknown };
  return typeof type === "string" ? type : typeof name === "string" ? name : undefined;
}

// kafkajs wraps the broker's error in a retry error, so look one level down too.
function errorTypes(error: unknown): string[] {
  const inner = typeof error === "object" && error !== null ? (error as { originalError?: unknown }).originalError : undefined;
  return [errorType(error), errorType(inner)].filter((type): type is string => type !== undefined);
}

const FAILURES: Record<string, DeadLetterFailure> = {
  UNKNOWN_TOPIC_OR_PARTITION: "topic not found",
  TOPIC_AUTHORIZATION_FAILED: "not authorized",
  GROUP_AUTHORIZATION_FAILED: "not authorized",
  CLUSTER_AUTHORIZATION_FAILED: "not authorized",
  SASL_AUTHENTICATION_FAILED: "not authorized",
  KafkaJSSASLAuthenticationError: "not authorized",
  KafkaJSConnectionError: "Kafka unreachable",
  KafkaJSBrokerNotFound: "Kafka unreachable",
};

function toReadError(error: unknown): DeadLetterReadError {
  if (error instanceof DeadLetterReadError) return error;
  for (const type of errorTypes(error)) {
    const reason = FAILURES[type];
    if (reason) return new DeadLetterReadError(reason);
  }
  return new DeadLetterReadError("read failed");
}

function groupAlreadyGone(error: unknown): boolean {
  const groups = typeof error === "object" && error !== null ? (error as { groups?: unknown }).groups : undefined;
  return Array.isArray(groups) && groups.length > 0 && groups.every((group) => errorType((group as { error?: unknown }).error) === "GROUP_ID_NOT_FOUND");
}

// Reads offset ranges through one consumer. kafkajs has no manual assignment, so the consumer joins
// its own group, which assigns it every partition, and the reader seeks to each range and pauses
// the partitions it does not need.
function rangeReader(consumer: ReaderConsumer, topic: string, partitions: number[]) {
  let pending = new Map<number, Range & { next: number; records: Map<number, RawRecord> }>();
  let settle: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  let failure: unknown = null;

  const settleIfDone = () => {
    if (settle && [...pending.values()].every((range) => range.next >= range.to)) settle.resolve();
  };

  const read: ReadRanges = async (ranges) => {
    if (failure) throw failure;
    pending = new Map(ranges.filter((r) => r.to > r.from).map((r) => [r.partition, { ...r, next: r.from, records: new Map() }]));
    const idle = partitions.filter((p) => !pending.has(p));
    if (idle.length > 0) consumer.pause([{ topic, partitions: idle }]);
    for (const range of pending.values()) consumer.seek({ topic, partition: range.partition, offset: String(range.from) });
    consumer.resume([{ topic, partitions: [...pending.keys()] }]);
    try {
      await new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
        settleIfDone();
      });
    } finally {
      settle = null;
    }
    return new Map([...pending.values()].map((range) => [range.partition, [...range.records.values()].sort((a, b) => a.offset - b.offset)]));
  };

  return {
    read,
    fail(error: unknown) {
      failure = error;
      settle?.reject(error);
    },
    accept(batch: Batch) {
      const range = pending.get(batch.partition);
      if (!range) return;
      for (const message of batch.messages) {
        const offset = Number(message.offset);
        if (offset < range.from || offset >= range.to) continue;
        range.records.set(offset, { offset, timestamp: Number(message.timestamp), value: message.value?.toString("utf8") ?? null });
      }
    },
    // Called for every fetched batch, including one that held only transaction markers, which
    // never reaches eachBatch. A batch from before the latest seek starts outside the range.
    progress(partition: number, firstOffset: string | null, lastOffset: string) {
      const range = pending.get(partition);
      if (!range || range.next >= range.to || firstOffset === null) return;
      const first = Number(firstOffset);
      if (first < range.from || first >= range.to) return;
      range.next = Math.max(range.next, Number(lastOffset) + 1);
      if (range.next >= range.to) consumer.pause([{ topic, partitions: [partition] }]);
      settleIfDone();
    },
  };
}

// Takes rows newest first across partitions until the page is full, every lane reached its start,
// or the page read READ_CAP records. Each lane reads older chunks, doubling in size, as it runs out.
async function collectPage(lanes: Lane[], filter: DeadLetterFilter, read: ReadRanges): Promise<Omit<DeadLetterPage, "older">> {
  const rows: DeadLetterRow[] = [];
  let budget = READ_CAP;
  while (rows.length < PAGE_SIZE) {
    const empty = lanes.filter((lane) => lane.buffer.length === 0 && lane.readFrom > lane.start);
    if (empty.length > 0) {
      if (budget === 0) return { rows, stoppedAtCap: true };
      const filling = empty.slice(0, budget);
      const share = Math.floor(budget / filling.length);
      const ranges = filling.map((lane) => {
        const size = Math.min(lane.chunk, share, lane.readFrom - lane.start);
        return { partition: lane.partition, from: lane.readFrom - size, to: lane.readFrom };
      });
      const records = await read(ranges);
      for (const [i, lane] of filling.entries()) {
        const { from, to } = ranges[i];
        budget -= to - from;
        lane.readFrom = from;
        lane.chunk = Math.min(lane.chunk * 2, READ_CAP);
        lane.buffer = (records.get(lane.partition) ?? [])
          .map((record) => parseDeadLetterRow({ partition: lane.partition, offset: record.offset, timestamp: record.timestamp }, record.value))
          .reverse();
        // Offsets that held no record, such as transaction markers, are passed.
        if (lane.buffer.length === 0) lane.before = from;
      }
      continue;
    }
    let newest: Lane | undefined;
    for (const lane of lanes) {
      if (lane.buffer.length > 0 && (!newest || lane.buffer[0].timestamp > newest.buffer[0].timestamp)) newest = lane;
    }
    if (!newest) break;
    const row = newest.buffer.shift()!;
    newest.before = newest.buffer.length > 0 ? row.offset : newest.readFrom;
    if (matchesFilter(row, filter)) rows.push(row);
  }
  return { rows, stoppedAtCap: false };
}

export function createDeadLetterReader(deps: DeadLetterReaderDeps): DeadLetterReader {
  const { topic, groupPrefix, now } = deps;
  const timeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const windows = new Map<number, { startedAt: number; partitions: Promise<PartitionWindow[]> }>();

  async function topicOffsets(admin: ReaderAdmin): Promise<Omit<PartitionWindow, "start">[]> {
    return (await admin.fetchTopicOffsets(topic)).map(({ partition, low, high }) => ({ partition, low: toOffset(low), end: toOffset(high) }));
  }

  // Rejects with "timed out" once timeoutMs pass. The work keeps running, so onTimeout must stop it.
  function bounded<T>(work: Promise<T>, onTimeout: (error: DeadLetterReadError) => void = () => undefined): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timedOut = new DeadLetterReadError("timed out");
        onTimeout(timedOut);
        reject(timedOut);
      }, timeoutMs);
    });
    work.catch(() => undefined);
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  async function fetchWindows(windowMs: number): Promise<PartitionWindow[]> {
    try {
      return await bounded(
        (async () => {
          const admin = await deps.admin();
          const [ends, starts] = await Promise.all([topicOffsets(admin), admin.fetchTopicOffsetsByTimestamp(topic, now() - windowMs)]);
          return ends.map(({ partition, low, end }) => {
            const atTime = starts.find((s) => s.partition === partition);
            const start = atTime ? Math.min(Math.max(toOffset(atTime.offset), low), end) : low;
            return { partition, low, start, end };
          });
        })(),
      );
    } catch (error) {
      throw toReadError(error);
    }
  }

  // Reuses each window's offsets, in flight or settled, for OFFSETS_REUSE_MS after the read
  // started, so studio reads them at most once per window however many viewers ask (HOM-NFR-03).
  function partitionWindows(windowMs: number): Promise<PartitionWindow[]> {
    const entry = windows.get(windowMs);
    if (entry && now() - entry.startedAt < OFFSETS_REUSE_MS) return entry.partitions;
    const fresh = { startedAt: now(), partitions: fetchWindows(windowMs) };
    windows.set(windowMs, fresh);
    // A failed read is not reused, so the next request after a broker blip tries again.
    fresh.partitions.catch(() => {
      if (windows.get(windowMs) === fresh) windows.delete(windowMs);
    });
    return fresh.partitions;
  }

  async function deleteGroup(groupId: string): Promise<void> {
    try {
      const admin = await deps.admin();
      await admin.deleteGroups([groupId]);
    } catch (error) {
      if (groupAlreadyGone(error)) return;
      console.warn(`[dead-letters] Could not delete consumer group ${groupId} (${errorType(error) ?? "unknown error"}). It holds no offsets.`);
    }
  }

  // One read, one group: a group id unique to the read, no commit, and the group deleted when the
  // read ends, whether it succeeded, failed, or ran out of time (DHL-FR-08).
  async function withGroup<T>(partitions: number[], readWith: (read: ReadRanges) => Promise<T>): Promise<T> {
    const groupId = `${groupPrefix}${deps.groupSuffix()}`;
    const consumer = deps.consumer(groupId);
    const reader = rangeReader(consumer, topic, partitions);
    let ended = false;
    let timedOut = false;
    const stopIfEnded = () => {
      if (ended) throw new DeadLetterReadError("timed out");
    };
    const work = (async () => {
      consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) => reader.progress(payload.partition, payload.firstOffset, payload.lastOffset));
      consumer.on(consumer.events.CRASH, ({ payload }) => reader.fail(payload.error));
      await consumer.connect();
      stopIfEnded();
      await consumer.subscribe({ topics: [topic], fromBeginning: false });
      stopIfEnded();
      await consumer.run({ autoCommit: false, eachBatch: async ({ batch }) => reader.accept(batch) });
      stopIfEnded();
      return readWith(reader.read);
    })();
    const release = async () => {
      await consumer.disconnect().catch((error: unknown) => {
        console.warn(`[dead-letters] Consumer ${groupId} did not disconnect cleanly (${errorType(error) ?? "unknown error"}).`);
      });
      await deleteGroup(groupId);
    };
    try {
      return await bounded(work, (error) => {
        timedOut = true;
        reader.fail(error);
      });
    } catch (error) {
      throw toReadError(error);
    } finally {
      ended = true;
      await release();
      // A disconnect during a connect or a join does not stop it: kafkajs still connects, or joins
      // the group and starts fetching. Release again once that step finishes.
      if (timedOut) void work.then(release, release);
    }
  }

  return {
    async droppedCount(windowMs) {
      const partitions = await partitionWindows(windowMs);
      return partitions.reduce((sum, p) => sum + (p.end - p.start), 0);
    },

    async readPage({ windowMs, filter = {}, cursor }) {
      const partitions = await partitionWindows(windowMs);
      const lanes: Lane[] = [];
      for (const window of partitions) {
        const from = cursor ? cursor.partitions.find((c) => c.partition === window.partition) : { start: window.start, before: window.end };
        if (!from) continue;
        // Retention may have deleted the oldest offsets since the cursor was made.
        const start = Math.max(from.start, window.low);
        const before = Math.max(start, Math.min(from.before, window.end));
        lanes.push({ partition: window.partition, start, before, readFrom: before, buffer: [], chunk: PAGE_SIZE });
      }
      if (lanes.every((lane) => lane.before <= lane.start)) return { rows: [], older: null, stoppedAtCap: false };
      const page = await withGroup(
        partitions.map((p) => p.partition),
        (read) => collectPage(lanes, filter, read),
      );
      const older = lanes.some((lane) => lane.before > lane.start)
        ? { partitions: lanes.map(({ partition, start, before }) => ({ partition, start, before })) }
        : null;
      return { ...page, older };
    },

    async readContent(partition, offset) {
      if (!Number.isSafeInteger(partition) || !Number.isSafeInteger(offset) || offset < 0) return null;
      let partitions: Omit<PartitionWindow, "start">[];
      try {
        partitions = await bounded((async () => topicOffsets(await deps.admin()))());
      } catch (error) {
        throw toReadError(error);
      }
      const window = partitions.find((p) => p.partition === partition);
      if (!window || offset < window.low || offset >= window.end) return null;
      return withGroup(
        partitions.map((p) => p.partition),
        async (read) => {
          const record = (await read([{ partition, from: offset, to: offset + 1 }])).get(partition)?.[0];
          return record ? parseDeadLetterContent(record.value) : null;
        },
      );
    },

    async retention() {
      try {
        const admin = await deps.admin();
        const { resources } = await admin.describeConfigs({
          includeSynonyms: false,
          resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configNames: ["retention.ms"] }],
        });
        const resource = resources[0];
        if (!resource || resource.errorCode !== 0) return { kind: "unknown" };
        return parseRetention(resource.configEntries.find((entry) => entry.configName === "retention.ms")?.configValue);
      } catch {
        return { kind: "unknown" };
      }
    },
  };
}
