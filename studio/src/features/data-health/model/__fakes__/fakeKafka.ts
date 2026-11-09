import type { ReaderAdmin, ReaderConsumer } from "../deadLetterReader";

export interface LogRecord {
  offset: number;
  timestamp: number;
  value: string | null;
  // A transaction marker: it takes an offset, but kafkajs never hands it to eachBatch.
  marker?: boolean;
}

export interface Partition {
  low: number;
  records: LogRecord[];
}

type Listener = (event: { payload: Record<string, unknown> }) => void;

const EVENTS = { END_BATCH_PROCESS: "consumer.end_batch_process", CRASH: "consumer.crash" };

// Fetches like kafkajs: from the latest offset until a seek, a batch of up to batchSize offsets at
// a time, skipping paused partitions, and emitting END_BATCH_PROCESS after each batch. With
// `prefetch`, a seek first delivers one batch from the old position, as a fetch already in flight does.
export class FakeConsumer {
  readonly events = EVENTS;
  readonly commitOffsets = jest.fn();
  readonly seeks: { partition: number; offset: number }[] = [];
  runOptions: { autoCommit?: boolean } | undefined;
  disconnected = false;
  connected = false;
  // In the group: set when run's join finishes, cleared by a disconnect that stops a running consumer.
  member = false;
  private listeners = new Map<string, Listener[]>();
  private paused = new Set<number>();
  private positions = new Map<number, number>();
  private running = false;
  private eachBatch: ((args: { batch: unknown }) => Promise<void>) | undefined;
  private inFlight: { partition: number; position: number }[] = [];

  constructor(
    private readonly log: Map<number, Partition>,
    private readonly behavior: Behavior & { batchSize: number },
  ) {
    for (const [partition, p] of log) this.positions.set(partition, p.low + p.records.length);
  }

  connect = jest.fn(async () => {
    if (this.behavior.hangConnect) await new Promise(() => undefined);
    if (this.behavior.failConnect) throw this.behavior.failConnect;
    await this.behavior.connectGate;
    this.connected = true;
  });
  subscribe = jest.fn(async () => undefined);
  run = jest.fn(async (options: { autoCommit?: boolean; eachBatch: (args: { batch: unknown }) => Promise<void> }) => {
    this.runOptions = options;
    this.eachBatch = options.eachBatch;
    // Like kafkajs's Runner.start, the consumer runs once the join finishes, even after a disconnect.
    await this.behavior.runGate;
    this.member = true;
    this.running = true;
    void this.loop();
  });
  seek = jest.fn(({ partition, offset }: { partition: number; offset: string }) => {
    this.seeks.push({ partition, offset: Number(offset) });
    if (this.behavior.prefetch) this.inFlight.push({ partition, position: this.positions.get(partition)! });
    this.positions.set(partition, Number(offset));
  });
  pause = jest.fn((tps: { partitions?: number[] }[]) => tps.forEach((tp) => tp.partitions?.forEach((p) => this.paused.add(p))));
  resume = jest.fn((tps: { partitions?: number[] }[]) => tps.forEach((tp) => tp.partitions?.forEach((p) => this.paused.delete(p))));
  on = jest.fn((event: string, listener: Listener) => {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return () => undefined;
  });
  disconnect = jest.fn(async () => {
    if (this.running) this.member = false;
    this.running = false;
    this.connected = false;
    this.disconnected = true;
  });

  crash(error: unknown) {
    this.emit(EVENTS.CRASH, { error });
  }

  private emit(event: string, payload: Record<string, unknown>) {
    for (const listener of this.listeners.get(event) ?? []) listener({ payload });
  }

  private async deliver(partition: number, position: number): Promise<number | null> {
    const slice = this.log.get(partition)!.records.filter((r) => r.offset >= position).slice(0, this.behavior.batchSize);
    if (slice.length === 0) return null;
    const messages = slice
      .filter((r) => !r.marker)
      .map((r) => ({ offset: String(r.offset), timestamp: String(r.timestamp), value: r.value === null ? null : Buffer.from(r.value) }));
    if (messages.length > 0) await this.eachBatch!({ batch: { topic: "dl", partition, messages } });
    this.emit(EVENTS.END_BATCH_PROCESS, {
      topic: "dl",
      partition,
      firstOffset: String(slice[0].offset),
      lastOffset: String(slice[slice.length - 1].offset),
    });
    return slice[slice.length - 1].offset + 1;
  }

  private async loop() {
    while (this.running) {
      let fetched = false;
      for (const stale of this.inFlight.splice(0)) await this.deliver(stale.partition, stale.position);
      for (const partition of this.log.keys()) {
        if (this.paused.has(partition) || this.behavior.stall) continue;
        const next = await this.deliver(partition, this.positions.get(partition)!);
        if (next === null) continue;
        fetched = true;
        this.positions.set(partition, next);
      }
      await new Promise((resolve) => setTimeout(resolve, fetched ? 0 : 1));
    }
  }
}

export interface Behavior {
  failConnect?: unknown;
  hangConnect?: boolean;
  // A connect or a join that finishes only when the test resolves the gate.
  connectGate?: Promise<void>;
  runGate?: Promise<void>;
  stall?: boolean;
  prefetch?: boolean;
}

export interface FakeKafka {
  admin: { [K in keyof ReaderAdmin]: jest.Mock };
  consumers: FakeConsumer[];
  newConsumer: jest.Mock<ReaderConsumer, [string]>;
}

export function fakeKafka(
  log: Map<number, Partition>,
  behavior: Behavior & { batchSize?: number; retentionMs?: string } = {},
): FakeKafka {
  const consumers: FakeConsumer[] = [];
  const end = (p: Partition) => p.low + p.records.length;
  const admin = {
    fetchTopicOffsets: jest.fn(async () =>
      [...log].map(([partition, p]) => ({ partition, offset: String(end(p)), high: String(end(p)), low: String(p.low) })),
    ),
    fetchTopicOffsetsByTimestamp: jest.fn(async (_topic: string, timestamp: number) =>
      [...log].map(([partition, p]) => ({
        partition,
        offset: String(p.records.find((r) => r.timestamp >= timestamp)?.offset ?? end(p)),
      })),
    ),
    describeConfigs: jest.fn(async () => ({
      throttleTime: 0,
      resources: [
        {
          errorCode: 0,
          errorMessage: "",
          resourceName: "dl",
          resourceType: 2,
          configEntries: [{ configName: "retention.ms", configValue: behavior.retentionMs ?? "604800000" }],
        },
      ],
    })),
    deleteGroups: jest.fn(async (groupIds: string[]) => groupIds.map((groupId) => ({ groupId }))),
  };
  const newConsumer = jest.fn((groupId: string) => {
    void groupId;
    const consumer = new FakeConsumer(log, { batchSize: behavior.batchSize ?? 50, ...behavior });
    consumers.push(consumer);
    return consumer as unknown as ReaderConsumer;
  });
  return { admin, consumers, newConsumer };
}

export function deadLetter(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

// One partition whose offsets start at `low`, with one record per entry, `stepMs` apart, ending at `lastTimestamp`.
export function partitionOf(values: (string | null)[], lastTimestamp: number, stepMs = 1_000, low = 0): Partition {
  return {
    low,
    records: values.map((value, i) => ({ offset: low + i, timestamp: lastTimestamp - (values.length - 1 - i) * stepMs, value })),
  };
}
