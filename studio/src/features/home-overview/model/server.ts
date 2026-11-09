import "server-only";
import { readOnly } from "@/lib/db";
import { deadLetterReader } from "@/features/data-health/model/deadLetterServer";
import { DeadLetterReadError } from "@/features/data-health/model/deadLetterReader";
import type { TimeRange } from "@/shared/lib/time-range";
import type { Reading } from "@/shared/lib/format";
import {
  droppedUnavailable,
  HEALTH_WINDOW_MS,
  journeyPeriods,
  kpiPeriods,
  lagSeries,
  lastHour,
  parseCampaignRows,
  parseCountRows,
  parseInstant,
  parseLagRows,
  parseRecentRows,
  RECENT_LIMIT,
  spansOf,
  tally,
  topJourneys,
  type ActiveJourney,
  type KpiCounts,
  type LagSeries,
  type PipelineHealth,
  type RecentJourney,
} from "./home";
import { activeCampaigns, engineLagP95, eventTimeCounts, lastTransition, ownCampaigns } from "./queries";

// HOM-NFR-01 asks for 2 seconds. A read that runs well past it fails its region instead of hanging.
const STATEMENT_TIMEOUT_MS = 5_000;

export async function kpiCounts(range: TimeRange): Promise<KpiCounts> {
  const periods = kpiPeriods(range);
  const spans = spansOf(periods);
  const [setup, engagement, watch] = await readOnly(STATEMENT_TIMEOUT_MS, async (run) => [
    parseCountRows(await run(eventTimeCounts("setup", spans))),
    parseCountRows(await run(eventTimeCounts("engagement", spans))),
    parseCountRows(await run(eventTimeCounts("watch", spans))),
  ]);
  return {
    entries: tally(setup, periods),
    messages: tally(engagement, periods),
    watchSuccess: tally(watch, periods, (row) => row.branch === "success"),
    watchTimeout: tally(watch, periods, (row) => row.branch === "timeout"),
  };
}

export async function engineLag(range: TimeRange): Promise<LagSeries> {
  const periods = kpiPeriods(range);
  const rows = await readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseLagRows(await run(engineLagP95(spansOf(periods)))));
  return lagSeries(rows, periods);
}

export async function activeJourneys(range: TimeRange, now: number): Promise<ActiveJourney[]> {
  const periods = journeyPeriods(range, now);
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => {
    const campaigns = parseCampaignRows(await run(activeCampaigns()));
    if (campaigns.length === 0) return [];
    const ids = campaigns.map((campaign) => campaign.id);
    const entries = parseCountRows(await run(eventTimeCounts("setup", spansOf(periods), ids)));
    const messages = parseCountRows(await run(eventTimeCounts("engagement", [periods.current], ids)));
    return topJourneys(campaigns, entries, messages, periods);
  });
}

export async function recentJourneys(userId: string): Promise<RecentJourney[]> {
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseRecentRows(await run(ownCampaigns(userId, RECENT_LIMIT))));
}

async function droppedLastHour(): Promise<Reading<number>> {
  try {
    return { available: true, value: await deadLetterReader().droppedCount(HEALTH_WINDOW_MS) };
  } catch (error) {
    if (error instanceof DeadLetterReadError) return droppedUnavailable(error.reason);
    console.warn(`[home] Dropped records could not be counted (${error instanceof Error ? error.name : "unknown error"}).`);
    return droppedUnavailable("read failed");
  }
}

export async function pipelineHealth(now: number): Promise<PipelineHealth> {
  const [database, dropped] = await Promise.all([
    readOnly(STATEMENT_TIMEOUT_MS, async (run) => ({
      lag: parseLagRows(await run(engineLagP95([lastHour(now)])))[0]?.p95 ?? null,
      lastTransitionAt: parseInstant((await run(lastTransition()))[0]?.last_at),
    })),
    droppedLastHour(),
  ]);
  return { ...database, dropped };
}
