import type { DeadLetterFailure } from "./deadLetterReader";
import { DROP_REASONS, type ReasonChoice, type RecordChoice } from "./deadLetterQuery";
import type { DeadLetterRow, Retention } from "./deadLetters";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function retentionSpan(ms: number): string {
  if (ms % DAY_MS === 0) return plural(ms / DAY_MS, "day");
  if (ms % HOUR_MS === 0) return plural(ms / HOUR_MS, "hour");
  return plural(Math.max(1, Math.round(ms / 60_000)), "minute");
}

// DHL-FR-11: the topic's retention, and what it means for older records.
export function retentionSentence(retention: Retention): string {
  switch (retention.kind) {
    case "bounded":
      return `Kept for ${retentionSpan(retention.ms)} by the topic. Older records are gone.`;
    case "unlimited":
      return "Kept without a time limit by the topic.";
    case "unknown":
      return "The topic's retention is unknown.";
    default: {
      const unhandled: never = retention;
      return unhandled;
    }
  }
}

// The first and last characters of a payload id, such as "3f9a…c1".
export function shortPayloadId(id: string): string {
  return id.length <= 7 ? id : `${id.slice(0, 4)}…${id.slice(-2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function reasonText(row: Exclude<DeadLetterRow, { record: "unreadable" }>): string {
  if (row.reason !== null) return row.reason;
  return row.record === "payload" ? "(grouped)" : "(none)";
}

// The words the Monitoring board gives each reason. The code stays beside them for the developer.
export const REASON_LABELS: Record<ReasonChoice, string> = {
  schema_invalid: "Didn't fit Strict rules",
  no_timestamp: "No time on the event",
  invalid_event_id: "Missing or broken event id",
  event_not_decoded: "Event couldn't be read",
  payload_not_decoded: "Request couldn't be read",
  grouped: "Request with dropped events",
};

// A reason the board does not name keeps its code alone.
export function reasonLabel(row: Exclude<DeadLetterRow, { record: "unreadable" }>): string | null {
  if (row.reason === null) return row.record === "payload" ? REASON_LABELS.grouped : null;
  const named = DROP_REASONS.find((reason) => reason === row.reason);
  return named ? REASON_LABELS[named] : null;
}

export const RECORD_LABELS: Record<RecordChoice, string> = { event: "Event", payload: "Request" };

export function payloadSizeText(row: DeadLetterRow): string | null {
  if (row.record !== "payload" || row.payloadSize === null) return null;
  return row.payloadTruncated ? `${formatBytes(row.payloadSize)}, cut` : formatBytes(row.payloadSize);
}

const FAILURES: readonly DeadLetterFailure[] = ["not configured", "topic not found", "not authorized", "Kafka unreachable", "timed out", "read failed"];

// The sentence for a failed request. Only a known reason is shown, never other server text.
export function failureMessage(status: number, body: unknown): string {
  if (status === 401) return "Your session ended. Sign in again to see dropped data.";
  if (status === 403) return "This page is for admins.";
  const reason = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  const known = FAILURES.find((failure) => failure === reason);
  return known ? `Dropped data could not load: ${known}.` : "Dropped data could not load.";
}
