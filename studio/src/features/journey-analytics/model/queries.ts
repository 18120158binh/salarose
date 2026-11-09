import type { SqlQuery } from '@/lib/db'
import type { Span } from '@/shared/lib/time-range'
import { nodeLabel, removedStepLabel, type NameLookup } from './labels'
import { isJsonObject, parseNodeRow, sortBranches, treeOrder, type JourneyNode } from './nodes'

type Row = Record<string, unknown>

export type BranchCount = { readonly branch: string; readonly entries: number }

export type NodeAnalytics = {
  readonly node: JourneyNode
  readonly label: string
  readonly depth: number
  readonly entered: number
  readonly completed: number
  readonly waiting: number
  readonly split: readonly BranchCount[]
}

export type RemovedStep = { readonly nodeId: string; readonly nodeType: string; readonly label: string; readonly entries: number }

export type WaitingStep = {
  readonly campaignId: string
  readonly entryId: string
  readonly node: JourneyNode
  readonly label: string
  /** Epoch ms. Null when the step is not a watch or its parent's `children` give no limit for it. */
  readonly deadline: number | null
}

// All time gets its own text with no range predicate, rather than `$2 IS NULL OR ...`, so that the
// planner never has to choose a plan that serves both.
function inSpan(campaignId: string, span: Span | null, build: (range: string) => string): SqlQuery {
  return span === null
    ? { text: build(''), values: [campaignId] }
    : { text: build('AND t.event_timestamp >= $2 AND t.event_timestamp < $3'), values: [campaignId, span.start, span.end] }
}

export function campaignNodesQuery(campaignIds: readonly string[]): SqlQuery {
  return {
    text: `SELECT campaign_id, node_id, node_type, parent_node_id, parent_branch, trigger_json, paths_json, action_json
FROM campaign_nodes WHERE campaign_id = ANY($1::text[])`,
    values: [[...campaignIds]],
  }
}

/**
 * JBD-FR-19, as node analytics defines it. A total row gives Entered, and a null branch Waiting.
 * `reach` holds each entry once, and the primary key allows one transition per entry, node, and
 * branch, so plain counts are distinct counts. Only the setup arm takes DISTINCT, because it reads
 * the setup node's transitions on every branch.
 *
 * The lateral join runs once per node, so every scan reads one node's range of idx_ucst_node_reach,
 * which inserts fill in time order, and each hash join holds one node's transitions. Joining every
 * node's reach in one statement made the planner read all of the campaign's transitions through a
 * sequential or primary key scan and spill one large join. For 846k transitions on Postgres 16 with
 * reads capped like a gp3 volume, that took 7.4 s cold and 1.5 s warm, against 2.4 s and 1.0 s
 * (#328). `t.branch >= ''` holds for every row. It keeps the setup arm on idx_ucst_node_reach for
 * All time, where the planner otherwise picks idx_ucst_campaign_node, whose pages lie scattered on
 * disk, and a cold run took 1.1 s longer.
 */
export function nodeAnalyticsQuery(campaignId: string, span: Span | null): SqlQuery {
  return inSpan(
    campaignId,
    span,
    (range) => `WITH nodes AS (
  SELECT node_id, node_type, parent_node_id, parent_branch FROM campaign_nodes WHERE campaign_id = $1
)
SELECT n.node_id, s.branch, s.total, s.entries
FROM nodes n CROSS JOIN LATERAL (
  WITH reach AS (
    SELECT DISTINCT t.canon_id, t.entry_id FROM user_campaign_state_transitions t
    WHERE n.node_type = 'setup' AND t.campaign_id = $1 AND t.node_id = n.node_id AND t.branch >= '' ${range}
    UNION ALL
    SELECT t.canon_id, t.entry_id FROM user_campaign_state_transitions t
    WHERE n.node_type <> 'setup' AND t.campaign_id = $1 AND t.node_id = n.parent_node_id AND t.branch = n.parent_branch ${range}
  )
  SELECT NULL AS branch, 1 AS total, count(*)::int AS entries FROM reach
  UNION ALL
  SELECT c.branch, 0, count(*)::int
  FROM reach r LEFT JOIN user_campaign_state_transitions c
    ON c.campaign_id = $1 AND c.node_id = n.node_id AND c.canon_id = r.canon_id AND c.entry_id = r.entry_id
  GROUP BY c.branch
) s`,
  )
}

/**
 * JBD-FR-21. The distinct node ids come from a loose index scan, one probe per id, so that the
 * query does not read every transition of the campaign over all time. The node type's ORDER BY
 * makes the planner read that row through an index: with LIMIT alone it chose a sequential scan,
 * which stops at the first match but can read most of the table for a rare id.
 */
export function removedStepsQuery(campaignId: string, span: Span | null): SqlQuery {
  return inSpan(
    campaignId,
    span,
    (range) => `WITH RECURSIVE ids AS (
  SELECT min(node_id) AS node_id FROM user_campaign_state_transitions WHERE campaign_id = $1
  UNION ALL
  SELECT (SELECT min(t.node_id) FROM user_campaign_state_transitions t WHERE t.campaign_id = $1 AND t.node_id > ids.node_id)
  FROM ids WHERE ids.node_id IS NOT NULL
),
removed AS (
  SELECT i.node_id FROM ids i
  WHERE i.node_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM campaign_nodes n WHERE n.campaign_id = $1 AND n.node_id = i.node_id)
)
SELECT r.node_id,
  (SELECT t.node_type FROM user_campaign_state_transitions t WHERE t.campaign_id = $1 AND t.node_id = r.node_id
   ORDER BY t.branch LIMIT 1) AS node_type,
  (SELECT count(DISTINCT (t.canon_id, t.entry_id))::int FROM user_campaign_state_transitions t
   WHERE t.campaign_id = $1 AND t.node_id = r.node_id ${range}) AS entries
FROM removed r
ORDER BY r.node_id`,
  )
}

/** The waiting steps of every entry of one person, across campaigns. */
export function waitingStepsQuery(canonId: string): SqlQuery {
  return {
    text: `SELECT p.campaign_id, p.entry_id, n.node_id, p.event_timestamp AS parent_event_timestamp, p.children
FROM user_campaign_state_transitions p
JOIN campaign_nodes n ON n.campaign_id = p.campaign_id AND n.parent_node_id = p.node_id AND n.parent_branch = p.branch
WHERE p.canon_id = $1 AND n.node_type <> 'setup'
  AND NOT EXISTS (
    SELECT 1 FROM user_campaign_state_transitions c
    WHERE c.canon_id = $1 AND c.campaign_id = p.campaign_id AND c.entry_id = p.entry_id AND c.node_id = n.node_id
  )
ORDER BY p.campaign_id, p.entry_id, n.node_id`,
    values: [canonId],
  }
}

/**
 * CMP-FR-19: the distinct people with an entry that has a waiting step in one campaign, over all
 * time. A step waits when its parent recorded the branch that leads to it and the entry has no
 * transition at the step yet, as waitingStepsQuery reads it for one person.
 */
export function peopleWaitingQuery(campaignId: string): SqlQuery {
  return {
    text: `SELECT count(DISTINCT p.canon_id)::int AS people
FROM user_campaign_state_transitions p
JOIN campaign_nodes n ON n.campaign_id = p.campaign_id AND n.parent_node_id = p.node_id AND n.parent_branch = p.branch
WHERE p.campaign_id = $1 AND n.node_type <> 'setup'
  AND NOT EXISTS (
    SELECT 1 FROM user_campaign_state_transitions c
    WHERE c.campaign_id = $1 AND c.canon_id = p.canon_id AND c.entry_id = p.entry_id AND c.node_id = n.node_id
  )`,
    values: [campaignId],
  }
}

export function namesQuery(names: { readonly events: readonly string[]; readonly segments: readonly string[] }): SqlQuery {
  return {
    text: `SELECT 'event' AS kind, event_name AS key, display_name AS name FROM user_events WHERE event_name = ANY($1::text[])
UNION ALL
SELECT 'segment', id, name FROM segments WHERE id = ANY($2::text[])`,
    values: [[...names.events], [...names.segments]],
  }
}

function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Expected text in ${column}, got ${typeof value}.`)
  return value
}

function textOrNull(row: Row, column: string): string | null {
  return row[column] === null ? null : text(row, column)
}

// node-postgres returns bigint columns as strings.
function safeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' || typeof value === 'bigint' ? Number(value) : NaN
  return Number.isSafeInteger(number) ? number : null
}

function integer(row: Row, column: string): number {
  const value = safeInteger(row[column])
  if (value === null) throw new Error(`Expected an integer in ${column}, got ${String(row[column])}.`)
  return value
}

/** Current nodes by campaign. Rows that do not parse are left out, as `parseNodeRow` says. */
export function nodesByCampaign(rows: readonly Row[]): Map<string, JourneyNode[]> {
  const byCampaign = new Map<string, JourneyNode[]>()
  for (const row of rows) {
    const node = parseNodeRow(row)
    if (node === null) continue
    const campaignId = text(row, 'campaign_id')
    const nodes = byCampaign.get(campaignId) ?? []
    nodes.push(node)
    byCampaign.set(campaignId, nodes)
  }
  return byCampaign
}

export function nameLookup(rows: readonly Row[]): NameLookup {
  const events = new Map<string, string>()
  const segments = new Map<string, string>()
  for (const row of rows) {
    const name = textOrNull(row, 'name')
    if (name === null || name.trim() === '') continue
    const names = text(row, 'kind') === 'segment' ? segments : events
    names.set(text(row, 'key'), name)
  }
  return { eventDisplayName: (name) => events.get(name), segmentName: (id) => segments.get(id) }
}

type NodeCounts = { entered: number; waiting: number; readonly split: Map<string, number> }

/**
 * Every node gets a row, in tree order. A node with no reach gets zeros. The split holds the
 * branches of the node's current children, zero-filled, and every branch observed.
 */
export function assembleNodeAnalytics(nodes: readonly JourneyNode[], rows: readonly Row[], names: NameLookup): NodeAnalytics[] {
  const counts = new Map<string, NodeCounts>()
  for (const row of rows) {
    const nodeId = text(row, 'node_id')
    const branch = textOrNull(row, 'branch')
    const entries = integer(row, 'entries')
    const count = counts.get(nodeId) ?? { entered: 0, waiting: 0, split: new Map<string, number>() }
    counts.set(nodeId, count)
    if (integer(row, 'total') === 1) count.entered = entries
    else if (branch === null) count.waiting = entries
    else count.split.set(branch, entries)
  }

  const childBranches = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.parentId === null || node.parentBranch === null) continue
    const branches = childBranches.get(node.parentId) ?? []
    branches.push(node.parentBranch)
    childBranches.set(node.parentId, branches)
  }

  return treeOrder(nodes).map(({ node, depth }) => {
    const { entered, waiting, split } = counts.get(node.id) ?? { entered: 0, waiting: 0, split: new Map<string, number>() }
    const branches = sortBranches([...(childBranches.get(node.id) ?? []), ...split.keys()], node.branchOrder)
    return {
      node,
      label: nodeLabel(node.setting, names),
      depth,
      entered,
      completed: entered - waiting,
      waiting,
      split: branches.map((branch) => ({ branch, entries: split.get(branch) ?? 0 })),
    }
  })
}

export function parseRemovedSteps(rows: readonly Row[]): RemovedStep[] {
  return rows.map((row) => {
    const nodeType = text(row, 'node_type')
    return { nodeId: text(row, 'node_id'), nodeType, label: removedStepLabel(nodeType), entries: integer(row, 'entries') }
  })
}

export type WaitingRow = {
  readonly campaignId: string
  readonly entryId: string
  readonly nodeId: string
  /** Each watch child's deadline by node id, as epoch ms. */
  readonly deadlines: ReadonlyMap<string, number>
}

// CUS-FR-07: a watch child's deadline is the parent transition's event time plus the child's
// limit_millis in that transition's children. children that do not parse give no deadline.
function childDeadlines(parentEventTimestamp: number, children: unknown): Map<string, number> {
  if (!Array.isArray(children)) return new Map()
  return new Map(
    children.flatMap((child: unknown) => {
      if (!isJsonObject(child) || typeof child.node_id !== 'string') return []
      const limitMillis = safeInteger(child.limit_millis)
      return limitMillis === null ? [] : [[child.node_id, parentEventTimestamp + limitMillis] as const]
    }),
  )
}

export function parseWaitingRows(rows: readonly Row[]): WaitingRow[] {
  return rows.map((row) => ({
    campaignId: text(row, 'campaign_id'),
    entryId: text(row, 'entry_id'),
    nodeId: text(row, 'node_id'),
    deadlines: childDeadlines(integer(row, 'parent_event_timestamp'), row.children),
  }))
}

export function waitingCampaignIds(rows: readonly WaitingRow[]): string[] {
  return [...new Set(rows.map((row) => row.campaignId))]
}

export function assembleWaitingSteps(
  rows: readonly WaitingRow[],
  nodes: ReadonlyMap<string, readonly JourneyNode[]>,
  names: NameLookup,
): WaitingStep[] {
  return rows.flatMap((row) => {
    const node = nodes.get(row.campaignId)?.find((candidate) => candidate.id === row.nodeId)
    if (node === undefined) return []
    const deadline = node.setting.type === 'watch' ? (row.deadlines.get(node.id) ?? null) : null
    return [{ campaignId: row.campaignId, entryId: row.entryId, node, label: nodeLabel(node.setting, names), deadline }]
  })
}
