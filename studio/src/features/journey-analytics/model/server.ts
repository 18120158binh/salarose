import 'server-only'
import { readOnly, type RunQuery } from '@/lib/db'
import { eventTimeCounts } from '@/features/home-overview/model/queries'
import { parseCountRows } from '@/features/home-overview/model/home'
import { computeRange, type Span, type TimeZone } from '@/shared/lib/time-range'
import { requireViewer } from '@/widgets/v2-shell/model/viewer'
import {
  parseJourneySummary,
  publishedCampaignQuery,
  publishedCampaignsQuery,
  publishedJourneys,
  type JourneySummary,
  type PublishedJourney,
} from './journeyList'
import { catalogEvents } from '@/features/journey-builder/model/server'
import type { CatalogEvent } from '@/features/journey-builder/ui/JourneyBuilder'
import { referencedNames, type NameLookup } from './labels'
import type { JourneyNode } from './nodes'
import {
  assembleNodeAnalytics,
  assembleWaitingSteps,
  campaignNodesQuery,
  nameLookup,
  namesQuery,
  nodeAnalyticsQuery,
  nodeCompletedQuery,
  nodesByCampaign,
  parseNodeCompleted,
  publishedRootQuery,
  parseRemovedSteps,
  parseWaitingRows,
  peopleWaitingQuery,
  removedStepsQuery,
  waitingCampaignIds,
  waitingStepsQuery,
  type NodeAnalytics,
  type RemovedStep,
  type WaitingStep,
} from './queries'

// Decision 0035: each statement is bounded, so a slow journey fails its own region of the page.
const ANALYTICS_STATEMENT_TIMEOUT_MS = 5000

// Every loader checks the session itself before it reads, so that no page can skip the check.
// requireViewer is cached per request, so the page's own call and this one share one lookup.

async function loadNames(run: RunQuery, nodes: readonly JourneyNode[]): Promise<NameLookup> {
  return nameLookup(await run(namesQuery(referencedNames(nodes))))
}

/** JBD-FR-19: the header of one published journey, or null when the id names no published campaign. */
export async function loadJourneySummary(campaignId: string): Promise<JourneySummary | null> {
  await requireViewer()
  return readOnly(ANALYTICS_STATEMENT_TIMEOUT_MS, async (run) => {
    const [row] = await run(publishedCampaignQuery(campaignId))
    return row === undefined ? null : parseJourneySummary(row)
  })
}

/** An empty `nodes` means the campaign has no published nodes, or does not exist. */
export async function loadJourneyAnalytics(
  campaignId: string,
  span: Span | null,
): Promise<{ nodes: NodeAnalytics[]; removed: RemovedStep[] }> {
  await requireViewer()
  return readOnly(ANALYTICS_STATEMENT_TIMEOUT_MS, async (run) => {
    const nodes = nodesByCampaign(await run(campaignNodesQuery([campaignId]))).get(campaignId) ?? []
    const names = await loadNames(run, nodes)
    const analytics = await run(nodeAnalyticsQuery(campaignId, span))
    const removed = await run(removedStepsQuery(campaignId, span))
    return { nodes: assembleNodeAnalytics(nodes, analytics, names), removed: parseRemovedSteps(removed) }
  })
}

/** CMP-FR-19: how many people a delete takes out of the journey. */
export async function loadPeopleWaiting(campaignId: string): Promise<number> {
  await requireViewer()
  return readOnly(ANALYTICS_STATEMENT_TIMEOUT_MS, async (run) => {
    const [row] = await run(peopleWaitingQuery(campaignId))
    return typeof row?.people === 'number' ? row.people : 0
  })
}

export async function loadWaitingSteps(canonId: string): Promise<WaitingStep[]> {
  await requireViewer()
  return readOnly(ANALYTICS_STATEMENT_TIMEOUT_MS, async (run) => {
    const rows = parseWaitingRows(await run(waitingStepsQuery(canonId)))
    if (rows.length === 0) return []
    const nodes = nodesByCampaign(await run(campaignNodesQuery(waitingCampaignIds(rows))))
    const names = await loadNames(run, [...nodes.values()].flat())
    return assembleWaitingSteps(rows, nodes, names)
  })
}

/**
 * JBD-FR-18: every active and paused journey, with its entries in the Last 7 days range of the
 * viewer's zone, counted as the home overview counts them: setup transitions by event time. `now`
 * is the instant the range ends at (SHL-FR-15), so the page tells each last change against it too.
 */
export async function loadPublishedJourneys(zone: TimeZone): Promise<{ now: number; journeys: PublishedJourney[] }> {
  await requireViewer()
  const now = Date.now()
  const lastWeek = computeRange('7d', now, zone).current
  const journeys = await readOnly(ANALYTICS_STATEMENT_TIMEOUT_MS, async (run) => {
    const campaigns = await run(publishedCampaignsQuery())
    const ids = campaigns.flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
    if (ids.length === 0) return []
    return publishedJourneys(campaigns, parseCountRows(await run(eventTimeCounts('setup', [lastWeek], ids))))
  })
  return { now, journeys }
}

/** JBD-FR-09: each node's all-time Completed count. A node missing from the result completed nobody. */
export async function loadNodeCompleted(campaignId: string): Promise<Record<string, number>> {
  await requireViewer()
  return readOnly(ANALYTICS_STATEMENT_TIMEOUT_MS, async (run) => parseNodeCompleted(await run(nodeCompletedQuery(campaignId))))
}

export type JourneyCanvas = {
  readonly root: Record<string, unknown>
  readonly events: CatalogEvent[]
  readonly completed: Record<string, number>
  /** Epoch ms of the counts' read. */
  readonly readAt: number
}

/** JBD-FR-09: the Journey tab's first load. Null when the id names no published campaign with a readable journey. */
export async function loadJourneyCanvas(campaignId: string): Promise<JourneyCanvas | null> {
  await requireViewer()
  const [read, events] = await Promise.all([
    readOnly(ANALYTICS_STATEMENT_TIMEOUT_MS, async (run) => {
      const [row] = await run(publishedRootQuery(campaignId))
      const root = row?.root
      if (typeof root !== 'object' || root === null || Array.isArray(root)) return null
      return { root: root as Record<string, unknown>, completed: parseNodeCompleted(await run(nodeCompletedQuery(campaignId))) }
    }),
    catalogEvents(),
  ])
  return read === null ? null : { ...read, events, readAt: Date.now() }
}
