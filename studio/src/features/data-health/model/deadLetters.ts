import { parseKafkaConnection, type Env, type KafkaConnection } from "../../../shared/lib/kafkaConnection";

// A dead letter as the dead-letter browser lists it: every field of the record except its content
// (DHL-FR-07). The field meanings are event ingestion's dead-letter shape.
interface Position {
  partition: number;
  offset: number;
  // The record's Kafka timestamp, in epoch milliseconds. Windows, ordering, and paging use it.
  timestamp: number;
}

interface DropFields {
  // Null on the payload record that groups a payload's dropped events.
  reason: string | null;
  detail: string | null;
  droppedAt: number | null;
  payloadId: string | null;
}

export type DeadLetterRow =
  // eventName is null when ingestion could not read the event's name, or wrote the record before
  // it named dropped events.
  | (Position & DropFields & { record: "event"; eventName: string | null })
  | (Position & DropFields & { record: "payload"; payloadSize: number | null; payloadTruncated: boolean })
  // Not valid JSON, or no `record` field. Kept as a row, so the other rows still show.
  | (Position & { record: "unreadable" });

export type DeadLetterContent =
  | { record: "event"; event: unknown }
  // Thrift bytes in standard Base64, cut to ingestion's payload limit.
  | { record: "payload"; payload: string; payloadSize: number | null; payloadTruncated: boolean }
  | { record: "unreadable" };

// Undefined fields match every record. A null reason matches the grouping payload records. An
// event name matches only event records of that name.
export interface DeadLetterFilter {
  reason?: string | null;
  record?: "event" | "payload";
  eventName?: string;
}

export type Retention = { kind: "bounded"; ms: number } | { kind: "unlimited" } | { kind: "unknown" };

export interface DeadLetterConfig extends KafkaConnection {
  topic: string;
  groupPrefix: string;
}

const DEFAULT_TOPIC = "snowplow-parsed-dead-letters";
const DEFAULT_GROUP_PREFIX = "studio-dead-letters-";
// Letters, digits, dot, underscore, and dash: safe in a Kafka ACL with a prefixed resource pattern.
// The trailing dash keeps a prefixed ACL from also matching a pipeline group, such as
// `event-processor-group` under the prefix `event-processor`.
const GROUP_PREFIX = /^[A-Za-z0-9._-]*-$/;

// The topic ingestion writes dead letters to. Studio reads the same variable.
export function deadLetterTopic(env: Env): string {
  return env.KAFKA_EVENT_DEAD_LETTER_TOPIC?.trim() || DEFAULT_TOPIC;
}

// Null when DEAD_LETTER_KAFKA_BROKERS is unset. Throws on a setting that is present but invalid.
export function parseDeadLetterConfig(env: Env): DeadLetterConfig | null {
  const connection = parseKafkaConnection(env, "DEAD_LETTER");
  if (!connection) return null;
  const groupPrefix = env.DEAD_LETTER_GROUP_PREFIX?.trim() || DEFAULT_GROUP_PREFIX;
  if (!GROUP_PREFIX.test(groupPrefix)) {
    throw new Error("DEAD_LETTER_GROUP_PREFIX may hold only letters, digits, dots, underscores, and dashes, and must end with a dash.");
  }
  return { ...connection, topic: deadLetterTopic(env), groupPrefix };
}

type Fields = Record<string, unknown>;

// Never throws and never reports why a value failed to parse, since the reason can quote content.
function parseFields(value: string | null): Fields | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Fields) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function recordType(fields: Fields | null): "event" | "payload" | null {
  return fields?.record === "event" || fields?.record === "payload" ? fields.record : null;
}

export function parseDeadLetterRow(position: Position, value: string | null): DeadLetterRow {
  const fields = parseFields(value);
  const record = recordType(fields);
  if (!fields || !record) return { ...position, record: "unreadable" };
  const drop: DropFields = {
    reason: text(fields.reason),
    detail: text(fields.detail),
    droppedAt: integer(fields.dropped_at),
    payloadId: text(fields.payload_id),
  };
  if (record === "event") return { ...position, ...drop, record, eventName: text(fields.event_name) };
  return {
    ...position,
    ...drop,
    record,
    payloadSize: integer(fields.payload_size),
    payloadTruncated: fields.payload_truncated === true,
  };
}

export function parseDeadLetterContent(value: string | null): DeadLetterContent {
  const fields = parseFields(value);
  const record = recordType(fields);
  if (!fields || !record) return { record: "unreadable" };
  if (record === "event") {
    return typeof fields.event === "object" && fields.event !== null ? { record, event: fields.event } : { record: "unreadable" };
  }
  const payload = text(fields.payload);
  if (payload === null) return { record: "unreadable" };
  return { record, payload, payloadSize: integer(fields.payload_size), payloadTruncated: fields.payload_truncated === true };
}

export function matchesFilter(row: DeadLetterRow, filter: DeadLetterFilter): boolean {
  if (filter.reason === undefined && filter.record === undefined && filter.eventName === undefined) return true;
  if (row.record === "unreadable") return false;
  return (filter.reason === undefined || row.reason === filter.reason)
    && (filter.record === undefined || row.record === filter.record)
    && (filter.eventName === undefined || (row.record === "event" && row.eventName === filter.eventName));
}

// `retention.ms` as the topic configuration holds it. -1 keeps records forever.
export function parseRetention(value: string | undefined): Retention {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return { kind: "unknown" };
  const ms = Number(value.trim());
  if (ms === -1) return { kind: "unlimited" };
  return Number.isSafeInteger(ms) && ms > 0 ? { kind: "bounded", ms } : { kind: "unknown" };
}
