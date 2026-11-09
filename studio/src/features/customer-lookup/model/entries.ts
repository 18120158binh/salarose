import { nodeLabel, removedStepLabel, type NameLookup } from '@/features/journey-analytics/model/labels'
import { treeOrder, type JourneyNode } from '@/features/journey-analytics/model/nodes'
import type { WaitingStep } from '@/features/journey-analytics/model/queries'
import { integer, integerOrNull, text, textOrNull, type Shown } from './queries'

type Row = Record<string, unknown>

export type EntryNow =
  | { readonly kind: 'waiting'; readonly steps: readonly { readonly label: string; readonly deadline: number | null }[] }
  | { readonly kind: 'finished' }
  /** The campaign has no `campaign_nodes` rows. */
  | { readonly kind: 'journey-deleted' }

export type Entry = {
  readonly campaignId: string
  readonly entryId: string
  /** Null when no `campaigns` row exists: the journey reads "Deleted journey". */
  readonly journey: { readonly name: string; readonly ownerId: string | null } | null
  readonly entered: number
  readonly lastStep: string
  readonly now: EntryNow
}

/** One transition at an entry's latest event time. */
type LastCandidate = { readonly nodeId: string; readonly nodeType: string; readonly writtenAt: number | null }

type EntryRows = {
  readonly campaignId: string
  readonly entryId: string
  readonly journey: Entry['journey']
  readonly entered: number
  readonly candidates: LastCandidate[]
}

export function entryKey(campaignId: string, entryId: string): string {
  return JSON.stringify([campaignId, entryId])
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The campaign ids of the entries, for loading their current nodes. */
export function entryCampaignIds(rows: readonly Row[]): string[] {
  return [...new Set(rows.map((row) => text(row, 'campaign_id')))]
}

function groupEntries(rows: readonly Row[]): EntryRows[] {
  const entries = new Map<string, EntryRows>()
  for (const row of rows) {
    const campaignId = text(row, 'campaign_id')
    const entryId = text(row, 'entry_id')
    const key = entryKey(campaignId, entryId)
    let entry = entries.get(key)
    if (entry === undefined) {
      const name = textOrNull(row, 'campaign_name')
      entry = {
        campaignId,
        entryId,
        journey: name === null ? null : { name, ownerId: textOrNull(row, 'created_user') },
        entered: integer(row, 'entered'),
        candidates: [],
      }
      entries.set(key, entry)
    }
    entry.candidates.push({ nodeId: text(row, 'node_id'), nodeType: text(row, 'node_type'), writtenAt: integerOrNull(row, 'written_at') })
  }
  return [...entries.values()]
}

/**
 * Among the transitions at the latest event time: the latest write time, then the node deepest in
 * the tree, then the greatest node id. A parent and its automatic children share an event time and
 * often one transaction, so depth picks the child. A removed node has no depth and ranks below every current node.
 */
function lastStep(candidates: readonly LastCandidate[], depthOf: (nodeId: string) => number | undefined): LastCandidate {
  const rank = (candidate: LastCandidate) => [candidate.writtenAt ?? -Infinity, depthOf(candidate.nodeId) ?? -1] as const
  return candidates.reduce((best, candidate) => {
    const [bestWritten, bestDepth] = rank(best)
    const [written, depth] = rank(candidate)
    if (written !== bestWritten) return written > bestWritten ? candidate : best
    if (depth !== bestDepth) return depth > bestDepth ? candidate : best
    return byCodeUnits(candidate.nodeId, best.nodeId) > 0 ? candidate : best
  })
}

/**
 * CUS-FR-06, CUS-FR-07. `rows` are the entries query's rows, newest entry first. `nodes` are the
 * entries' campaigns' current nodes, and `waiting` the person's waiting steps, both from journey
 * analytics, so a step removed since an entry reached it no longer counts as waiting.
 */
export function assembleEntries(
  rows: readonly Row[],
  nodes: ReadonlyMap<string, readonly JourneyNode[]>,
  waiting: readonly WaitingStep[],
  names: NameLookup,
): Shown<Entry> {
  const total = rows.length === 0 ? 0 : integer(rows[0], 'total')
  const placed = new Map<string, Map<string, { node: JourneyNode; depth: number }>>()
  for (const [campaignId, campaignNodes] of nodes) {
    placed.set(campaignId, new Map(treeOrder(campaignNodes).map((place) => [place.node.id, place])))
  }
  const waitingByEntry = new Map<string, WaitingStep[]>()
  for (const step of waiting) {
    const key = entryKey(step.campaignId, step.entryId)
    waitingByEntry.set(key, [...(waitingByEntry.get(key) ?? []), step])
  }

  const entries = groupEntries(rows).map((entry): Entry => {
    const tree = placed.get(entry.campaignId)
    const last = lastStep(entry.candidates, (nodeId) => tree?.get(nodeId)?.depth)
    const node = tree?.get(last.nodeId)?.node
    const steps = waitingByEntry.get(entryKey(entry.campaignId, entry.entryId)) ?? []
    const now: EntryNow =
      tree === undefined
        ? { kind: 'journey-deleted' }
        : steps.length === 0
          ? { kind: 'finished' }
          : { kind: 'waiting', steps: steps.map((step) => ({ label: step.label, deadline: step.deadline })) }
    return {
      campaignId: entry.campaignId,
      entryId: entry.entryId,
      journey: entry.journey,
      entered: entry.entered,
      lastStep: node === undefined ? removedStepLabel(last.nodeType) : nodeLabel(node.setting, names),
      now,
    }
  })
  return { rows: entries, more: Math.max(0, total - entries.length) }
}
