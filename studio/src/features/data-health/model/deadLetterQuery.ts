import { computeRange, DEFAULT_RANGE, RANGE_KEYS, rangeLabel, type RangeKey, type TimeZone } from "@/shared/lib/time-range";
import type { DeadLetterCursor } from "./deadLetterReader";
import type { DeadLetterFilter } from "./deadLetters";

// What the dead-letter browser shows, as its address holds it. The page and the records route
// parse the same parameters, so a list the page asks for is the list the route reads.

// Monitoring's window follows the studio shell's ranges, in the viewer's time zone (owner default,
// 2026-11-08). Today starts at the viewer's midnight.
export const DEAD_LETTER_WINDOWS = RANGE_KEYS;
export type DeadLetterWindow = RangeKey;
export const DEFAULT_WINDOW: DeadLetterWindow = DEFAULT_RANGE;

// The window as an adverbial phrase: "Nothing was dropped today", "... in the last 7 days".
const PHRASE: Record<DeadLetterWindow, string> = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days" };

// Event ingestion's drop reasons.
export const DROP_REASONS = ["payload_not_decoded", "event_not_decoded", "invalid_event_id", "no_timestamp", "schema_invalid"] as const;
export type DropReason = (typeof DROP_REASONS)[number];

// "grouped" is the payload record with a null reason that groups a payload's dropped events.
export type ReasonChoice = DropReason | "grouped";
export const REASON_CHOICES: readonly ReasonChoice[] = [...DROP_REASONS, "grouped"];

export const RECORD_CHOICES = ["event", "payload"] as const;
export type RecordChoice = (typeof RECORD_CHOICES)[number];

// A null filter shows every record.
export interface DeadLetterQuery {
  window: DeadLetterWindow;
  reason: ReasonChoice | null;
  record: RecordChoice | null;
}

export const DEFAULT_QUERY: DeadLetterQuery = { window: DEFAULT_WINDOW, reason: null, record: null };

export type Param = (name: "window" | "reason" | "record") => string | undefined;

function choice<T extends string>(choices: readonly T[], value: string | undefined): T | null | undefined {
  if (value === undefined) return null;
  return choices.find((candidate) => candidate === value);
}

// Undefined when a parameter holds a value the page does not offer.
export function parseDeadLetterQuery(param: Param): DeadLetterQuery | undefined {
  const window = choice(DEAD_LETTER_WINDOWS, param("window"));
  const reason = choice(REASON_CHOICES, param("reason"));
  const record = choice(RECORD_CHOICES, param("record"));
  if (window === undefined || reason === undefined || record === undefined) return undefined;
  return { window: window ?? DEFAULT_WINDOW, reason, record };
}

// The query string of the browser's address, without the defaults: "" or "?window=1h&reason=...".
export function querySearch(query: DeadLetterQuery): string {
  const params = new URLSearchParams();
  if (query.window !== DEFAULT_WINDOW) params.set("window", query.window);
  if (query.reason !== null) params.set("reason", query.reason);
  if (query.record !== null) params.set("record", query.record);
  const search = params.toString();
  return search ? `?${search}` : "";
}

// A page address with the browser's query merged into its own parameters, such as
// "/v2/data/monitoring?tab=dropped" with the window: "/v2/data/monitoring?tab=dropped&window=1h".
export function queryHref(base: string, query: DeadLetterQuery): string {
  const [path, own = ""] = base.split("?", 2);
  const params = new URLSearchParams(own);
  for (const [name, value] of new URLSearchParams(querySearch(query))) params.set(name, value);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

// How far back the window reaches from now, as the reader takes it.
export function windowMs(window: DeadLetterWindow, zone: TimeZone, now: number): number {
  return now - computeRange(window, now, zone).current.start;
}

export function windowLabel(window: DeadLetterWindow): string {
  return rangeLabel(window);
}

export function windowPhrase(window: DeadLetterWindow): string {
  return PHRASE[window];
}

export function toFilter(query: DeadLetterQuery): DeadLetterFilter {
  return {
    ...(query.reason !== null && { reason: query.reason === "grouped" ? null : query.reason }),
    ...(query.record !== null && { record: query.record }),
  };
}

// The topic has far fewer partitions. The bound keeps a forged cursor from costing a large parse.
const MAX_CURSOR_PARTITIONS = 1_000;
const MAX_CURSOR_LENGTH = 100_000;

function position(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// The `older` parameter: the cursor of the previous page, as JSON. Undefined when it is not one.
export function parseCursor(value: string): DeadLetterCursor | undefined {
  if (value.length > MAX_CURSOR_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const partitions = typeof parsed === "object" && parsed !== null ? (parsed as { partitions?: unknown }).partitions : undefined;
  if (!Array.isArray(partitions) || partitions.length > MAX_CURSOR_PARTITIONS) return undefined;
  const seen = new Set<number>();
  const cursor: DeadLetterCursor = { partitions: [] };
  for (const entry of partitions) {
    const { partition, start, before } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (!position(partition) || !position(start) || !position(before) || start > before || seen.has(partition)) return undefined;
    seen.add(partition);
    cursor.partitions.push({ partition, start, before });
  }
  return cursor;
}

const DIGITS = /^\d{1,15}$/;

// A record's partition and offset, from the content route's parameters.
export function parsePosition(partition: string | null, offset: string | null): { partition: number; offset: number } | undefined {
  if (partition === null || offset === null || !DIGITS.test(partition) || !DIGITS.test(offset)) return undefined;
  return { partition: Number(partition), offset: Number(offset) };
}
