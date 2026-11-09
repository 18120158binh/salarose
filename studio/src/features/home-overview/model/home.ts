import type { ChartPoint } from "@/components/ui/chart";
import type { SystemRole } from "@/shared/auth/types";
import type { TrendUnit } from "@/shared/ui/v2/KpiSparkline";
import { formatCount, formatDuration, type Reading } from "@/shared/lib/format";
import { periodChange, wholePercent, type Change, type Ratio } from "@/shared/lib/period-change";
import { computeRange, splitIntoDays, type Day, type Span, type TimeRange } from "@/shared/lib/time-range";
import type { DeadLetterFailure } from "@/features/data-health/model/deadLetterReader";
import { liveHref, type NavId, type Reach } from "@/widgets/v2-shell/model/routes";

/**
 * The spans one read counts over: the range, its previous period, and the days of a daily
 * series. Queries number them 1 for current, 2 for previous, then the days in order.
 */
export type Periods = { readonly current: Span; readonly previous: Span; readonly days: readonly Day[] };

export function spansOf(periods: Periods): Span[] {
  return [periods.current, periods.previous, ...periods.days];
}

/** The range's periods. Today has no daily series, so it shows no sparkline (HOM-FR-04). */
export function kpiPeriods(range: TimeRange): Periods {
  return {
    current: range.current,
    previous: range.previous,
    days: range.key === "today" ? [] : splitIntoDays(range.current, range.zone),
  };
}

/** The range's periods, with the last 7 calendar days, today included, as the series. */
export function journeyPeriods(range: TimeRange, now: number): Periods {
  return { current: range.current, previous: range.previous, days: splitIntoDays(computeRange("7d", now, range.zone).current, range.zone) };
}

export type DailyValue<T> = { readonly date: string; readonly value: T };

export type Tally = { readonly current: number; readonly previous: number; readonly days: readonly DailyValue<number>[] };

export type CountRow = { readonly bucket: number; readonly campaignId: string; readonly branch: string; readonly n: number };

export type LagRow = { readonly bucket: number; readonly p95: number };

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

// pg returns count(*) as a string, so every number is parsed here.
export function parseCountRows(rows: readonly Record<string, unknown>[]): CountRow[] {
  return rows.flatMap((row) => {
    const bucket = finiteNumber(row.bucket);
    const n = finiteNumber(row.n);
    if (bucket === null || n === null || typeof row.campaign_id !== "string" || typeof row.branch !== "string") return [];
    return [{ bucket, campaignId: row.campaign_id, branch: row.branch, n }];
  });
}

export function parseLagRows(rows: readonly Record<string, unknown>[]): LagRow[] {
  return rows.flatMap((row) => {
    const bucket = finiteNumber(row.bucket);
    const p95 = finiteNumber(row.p95);
    return bucket === null || p95 === null ? [] : [{ bucket, p95 }];
  });
}

/** An instant from a timestamptz column, which pg returns as a Date. */
export function parseInstant(value: unknown): number | null {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/** Sums the rows that `keep` accepts into the range, the previous period, and each day. */
export function tally(rows: readonly CountRow[], periods: Periods, keep: (row: CountRow) => boolean = () => true): Tally {
  const sums = new Map<number, number>();
  for (const row of rows) if (keep(row)) sums.set(row.bucket, (sums.get(row.bucket) ?? 0) + row.n);
  return {
    current: sums.get(1) ?? 0,
    previous: sums.get(2) ?? 0,
    days: periods.days.map((day, index) => ({ date: day.date, value: sums.get(index + 3) ?? 0 })),
  };
}

/** p95 lag per period. `null` means no measured transition was written in it. */
export type LagSeries = {
  readonly current: number | null;
  readonly previous: number | null;
  readonly days: readonly DailyValue<number | null>[];
};

export function lagSeries(rows: readonly LagRow[], periods: Periods): LagSeries {
  const byBucket = new Map(rows.map((row) => [row.bucket, row.p95]));
  return {
    current: byBucket.get(1) ?? null,
    previous: byBucket.get(2) ?? null,
    days: periods.days.map((day, index) => ({ date: day.date, value: byBucket.get(index + 3) ?? null })),
  };
}

/** The four counts the KPI row reads by event time. */
export type KpiCounts = {
  readonly entries: Tally;
  readonly messages: Tally;
  readonly watchSuccess: Tally;
  readonly watchTimeout: Tally;
};

/**
 * A daily series as the sparkline draws it. A day with nothing to measure, such as no finished
 * watch, has no point: a 0 there would read as a measured value.
 */
export type Trend = { readonly points: readonly ChartPoint[]; readonly unit: TrendUnit };

export type KpiView = {
  readonly label: string;
  readonly definition: string;
  readonly value: Reading<string>;
  readonly change: Change | null;
  // A second line under the value, such as the counts behind a rate.
  readonly detail: string | null;
  // `null` for Today, which has no daily series.
  readonly trend: Trend | null;
};

const NO_WATCHES = "No watches finished";
const NO_ACTIVITY = "No activity";

const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

/** "Nov 7" for the calendar date "2026-11-07", whatever zone the server runs in. */
export function formatDay(date: string): string {
  return dayLabel.format(Date.parse(`${date}T00:00:00Z`));
}

function trendOf(days: readonly DailyValue<number | null>[], unit: TrendUnit): Trend | null {
  if (days.length === 0) return null;
  const points = days.flatMap((day) => (day.value === null ? [] : [{ label: formatDay(day.date), value: day.value }]));
  return { points, unit };
}

function countKpi(label: string, definition: string, counts: Tally): KpiView {
  return {
    label,
    definition,
    value: { available: true, value: formatCount(counts.current) },
    change: periodChange({ kind: "count", current: counts.current, previous: counts.previous }, "up"),
    detail: null,
    trend: trendOf(counts.days, "count"),
  };
}

export function entriesKpi(counts: KpiCounts): KpiView {
  return countKpi(
    "Entries",
    "How many times people entered a journey in this range. A person who entered twice counts twice.",
    counts.entries,
  );
}

export function messagesKpi(counts: KpiCounts): KpiView {
  return countKpi(
    "Messages requested",
    "How many messages journeys asked the sender to send in this range. Whether each was delivered is not known yet.",
    counts.messages,
  );
}

function watchRatio(success: number, timeout: number): Ratio {
  return { numerator: success, denominator: success + timeout };
}

export function watchKpi(counts: KpiCounts): KpiView {
  const current = watchRatio(counts.watchSuccess.current, counts.watchTimeout.current);
  const previous = watchRatio(counts.watchSuccess.previous, counts.watchTimeout.previous);
  const percent = wholePercent(current);
  return {
    label: "Watch success",
    definition: "Of the watches that finished in this range, the share where the person did what the journey waited for.",
    value: { available: true, value: percent === null ? NO_WATCHES : `${percent}%` },
    change: percent === null ? null : periodChange({ kind: "rate", current, previous }, "up"),
    detail: percent === null ? null : `${formatCount(current.numerator)} of ${formatCount(current.denominator)}`,
    trend: trendOf(
      counts.watchSuccess.days.map((day, index) => ({
        date: day.date,
        value: wholePercent(watchRatio(day.value, counts.watchTimeout.days[index]?.value ?? 0)),
      })),
      "percent",
    ),
  };
}

export function lagKpi(lag: LagSeries): KpiView {
  return {
    label: "Engine lag (p95)",
    definition:
      "How long after an event the engine moved people on, for 95% of the steps that start from an event, by the time the engine wrote them.",
    value: { available: true, value: lag.current === null ? NO_ACTIVITY : formatDuration(lag.current) },
    change: periodChange({ kind: "duration", current: lag.current, previous: lag.previous }, "down"),
    detail: null,
    trend: trendOf(lag.days, "duration"),
  };
}

export type CampaignRow = {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string | null;
  readonly ownerEmail: string | null;
};

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function parseCampaignRows(rows: readonly Record<string, unknown>[]): CampaignRow[] {
  return rows.flatMap((row) => {
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    return [{ id: row.id, name: row.name, ownerId: textOrNull(row.owner_id), ownerEmail: textOrNull(row.owner_email) }];
  });
}

export type ActiveJourney = CampaignRow & {
  readonly entries: number;
  readonly messages: number;
  // Entries in the range minus entries in the previous period.
  readonly change: number;
  readonly last7Days: readonly DailyValue<number>[];
};

export const JOURNEY_TABLE_LIMIT = 10;

/**
 * The journeys table: each active journey with its numbers, by the size of the change in entries,
 * largest first, then by name, at most 10 (HOM-FR-05). `messages` counts over the range only.
 */
export function topJourneys(
  campaigns: readonly CampaignRow[],
  entries: readonly CountRow[],
  messages: readonly CountRow[],
  periods: Periods,
): ActiveJourney[] {
  return campaigns
    .map((campaign) => {
      const ofCampaign = (row: CountRow) => row.campaignId === campaign.id;
      const entryTally = tally(entries, periods, ofCampaign);
      return {
        ...campaign,
        entries: entryTally.current,
        messages: tally(messages, periods, ofCampaign).current,
        change: entryTally.current - entryTally.previous,
        last7Days: entryTally.days,
      };
    })
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"))
    .slice(0, JOURNEY_TABLE_LIMIT);
}

export type JourneyStatus = "active" | "paused";

export type RecentJourney = {
  readonly id: string;
  readonly name: string;
  readonly status: JourneyStatus;
  readonly updatedAt: number;
};

export const RECENT_LIMIT = 5;

/** The viewer's own journeys. A row that does not parse is logged and left out. */
export function parseRecentRows(rows: readonly Record<string, unknown>[]): RecentJourney[] {
  return rows.flatMap((row) => {
    const updatedAt = parseInstant(row.updated_at);
    const status = row.status === "active" || row.status === "paused" ? row.status : null;
    if (typeof row.id !== "string" || typeof row.name !== "string" || status === null || updatedAt === null) {
      console.warn(`[home] Leaving campaign ${String(row.id)} out of Continue where you left off: its row does not parse.`);
      return [];
    }
    return [{ id: row.id, name: row.name, status, updatedAt }];
  });
}

export const HEALTH_WINDOW_MS = 3_600_000;

/** good, warning, and bad are the strip's states. `quiet` is neither: nothing to measure. */
export type HealthTone = "good" | "warning" | "bad" | "quiet";

const LAG_GOOD_MS = 60_000;
const LAG_WARNING_MS = 300_000;

// The thresholds are the lead's default (home overview, health strip).
export function lagTone(p95: number | null): HealthTone {
  if (p95 === null) return "quiet";
  if (p95 <= LAG_GOOD_MS) return "good";
  return p95 <= LAG_WARNING_MS ? "warning" : "bad";
}

export function droppedTone(count: number): HealthTone {
  return count === 0 ? "good" : "warning";
}

type PageLink = { readonly page: NavId; readonly text: string };

// Only an admin may open the dead-letter browser. An editor gets the event catalog view.
const DROPPED_LINKS: Record<SystemRole, readonly PageLink[]> = {
  admin: [
    { page: "dead-letters", text: "Open dead letters" },
    { page: "events", text: "Open events" },
  ],
  editor: [{ page: "events", text: "Open events" }],
};

/**
 * The first data page on the role's list that has somewhere to go today: the v2 page once it
 * ships, or the classic page that does its job. Null when none has.
 */
export function droppedLink(viewer: Reach): { href: string; text: string } | null {
  for (const { page, text } of DROPPED_LINKS[viewer.role]) {
    const href = liveHref(page, viewer);
    if (href !== null) return { href, text };
  }
  return null;
}

const DROPPED_REASONS: Record<DeadLetterFailure, string> = {
  "not configured": "Studio is not set up to read dropped records.",
  "topic not found": "The dead-letter topic does not exist.",
  "not authorized": "Studio may not read the dead-letter topic.",
  "Kafka unreachable": "Kafka could not be reached.",
  "timed out": "Kafka took too long to answer.",
  "read failed": "The dead-letter topic could not be read.",
};

export function droppedUnavailable(reason: DeadLetterFailure): Reading<number> {
  return { available: false, reason: DROPPED_REASONS[reason] };
}

export type PipelineHealth = {
  // p95 lag of the measured transitions written in the last hour, or null with none.
  readonly lag: number | null;
  readonly lastTransitionAt: number | null;
  readonly dropped: Reading<number>;
};

export function lastHour(now: number): Span {
  return { start: now - HEALTH_WINDOW_MS, end: now };
}
