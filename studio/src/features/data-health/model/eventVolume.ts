import type { SqlQuery } from "@/lib/db";

// DHL-FR-14, DHL-FR-18. Per-event counts that the event parse job keeps in event_volume: one row per event name, hour,
// and outcome. The outcome is "accepted" or the drop reason of a dropped event ingestion could
// name. A drop it could not name, such as an unreadable request, is only in the dead-letter total.

// The shell's windows (lead default 6 on #382). "today" starts at midnight in the deployment's
// time zone.
export const VOLUME_WINDOWS = ["today", "7d", "30d"] as const;
export type VolumeWindow = (typeof VOLUME_WINDOWS)[number];
export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const SPARKLINE_DAYS = 7;
const QUIET_AFTER_MS = 7 * DAY_MS;
const OLDEST_WINDOW_MS = 30 * DAY_MS;

// DHL-FR-18: "receiving" has an accepted event in the window, "quiet" has none in 7 days but was
// seen before, and "never" was never seen. "idle" has none in the window but one in the last 7
// days, which the contract does not name.
export type Arrival = "receiving" | "idle" | "quiet" | "never";

export interface EventVolume {
  eventName: string;
  accepted: number;
  dropped: number;
  droppedByReason: Record<string, number>;
  // Accepted events per day for the last 7 days, oldest first. Each day is 24 hours, and the last
  // ends with the current hour.
  daily: number[];
  // The latest accepted event's time, ISO 8601, or null when none was ever counted.
  lastSeenAt: string | null;
  arrival: Arrival;
}

export interface VolumeRow {
  eventName: string;
  bucketStart: number;
  outcome: string;
  count: number;
}

export interface LastSeenRow {
  eventName: string;
  lastSeenAt: number;
}

// Every row young enough for the sparkline or the widest window, for the named events. The 30-day
// window reaches one day further back, which covers any time zone's midnight.
export function volumeRowsQuery(eventNames: readonly string[], now: number): SqlQuery {
  return {
    text: `SELECT event_name, bucket_start, outcome, count FROM event_volume
WHERE event_name = ANY($1::text[]) AND bucket_start >= $2`,
    values: [eventNames, new Date(oldestBucket(now))],
  };
}

// The latest accepted event of each named event, at any age.
export function lastSeenQuery(eventNames: readonly string[]): SqlQuery {
  return {
    text: `SELECT event_name, max(last_seen_at) AS last_seen_at FROM event_volume
WHERE event_name = ANY($1::text[]) AND outcome = 'accepted' GROUP BY event_name`,
    values: [eventNames],
  };
}

function hourStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

// The end of the current hour, which closes the last sparkline day.
function sparklineEnd(now: number): number {
  return hourStart(now) + HOUR_MS;
}

function oldestBucket(now: number): number {
  return hourStart(now - OLDEST_WINDOW_MS - DAY_MS);
}

// The window's first instant: midnight in timeZone, today or 6 or 29 days before.
export function windowStart(window: VolumeWindow, now: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const daysBack = window === "today" ? 0 : window === "7d" ? 6 : 29;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)]));
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(now / 1000) * 1000;
  return Date.UTC(parts.year, parts.month - 1, parts.day - daysBack) - offset;
}

function epochMs(value: unknown): number | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function count(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

// A row that does not parse is left out, so one bad row cannot hide the others.
export function parseVolumeRows(rows: Record<string, unknown>[]): VolumeRow[] {
  return rows.flatMap((row) => {
    const bucketStart = epochMs(row.bucket_start);
    const n = count(row.count);
    if (typeof row.event_name !== "string" || typeof row.outcome !== "string" || bucketStart === null || n === null) {
      return [];
    }
    return [{ eventName: row.event_name, bucketStart, outcome: row.outcome, count: n }];
  });
}

export function parseLastSeenRows(rows: Record<string, unknown>[]): LastSeenRow[] {
  return rows.flatMap((row) => {
    const lastSeenAt = epochMs(row.last_seen_at);
    return typeof row.event_name === "string" && lastSeenAt !== null ? [{ eventName: row.event_name, lastSeenAt }] : [];
  });
}

// One entry per requested name, in the order given, with zeros for a name with no rows.
export function summarizeEventVolume(
  eventNames: readonly string[],
  rows: readonly VolumeRow[],
  lastSeen: readonly LastSeenRow[],
  window: VolumeWindow,
  now: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): EventVolume[] {
  const start = windowStart(window, now, timeZone);
  const end = sparklineEnd(now);
  const byName = new Map<string, EventVolume>();
  for (const eventName of eventNames) {
    byName.set(eventName, {
      eventName,
      accepted: 0,
      dropped: 0,
      droppedByReason: {},
      daily: Array<number>(SPARKLINE_DAYS).fill(0),
      lastSeenAt: null,
      arrival: "never",
    });
  }
  for (const row of rows) {
    const volume = byName.get(row.eventName);
    if (!volume) continue;
    const accepted = row.outcome === "accepted";
    if (row.bucketStart >= start && row.bucketStart <= now) {
      if (accepted) volume.accepted += row.count;
      else {
        volume.dropped += row.count;
        volume.droppedByReason[row.outcome] = (volume.droppedByReason[row.outcome] ?? 0) + row.count;
      }
    }
    const day = SPARKLINE_DAYS - 1 - Math.floor((end - HOUR_MS - row.bucketStart) / DAY_MS);
    if (accepted && day >= 0 && day < SPARKLINE_DAYS) volume.daily[day] += row.count;
  }
  for (const { eventName, lastSeenAt } of lastSeen) {
    const volume = byName.get(eventName);
    if (!volume) continue;
    volume.lastSeenAt = new Date(lastSeenAt).toISOString();
    volume.arrival = volume.accepted > 0 ? "receiving" : now - lastSeenAt <= QUIET_AFTER_MS ? "idle" : "quiet";
  }
  return eventNames.map((eventName) => byName.get(eventName)!);
}
