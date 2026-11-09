/** @jest-environment node */

import {
  assembleNodeAnalytics,
  assembleWaitingSteps,
  campaignNodesQuery,
  nameLookup,
  nodeAnalyticsQuery,
  nodesByCampaign,
  parseRemovedSteps,
  parseWaitingRows,
  removedStepsQuery,
  waitingStepsQuery,
  type NodeAnalytics,
  type WaitingStep,
} from '../queries'
import type { SqlQuery } from '@/lib/db'
import type { Span } from '@/shared/lib/time-range'
import { journeySql, runPostgres, type NodeFixture, type Rows, type TransitionFixture } from '../testing/pg'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 1)
const SPAN = { start: T0, end: T0 + DAY }
const POSTGRES_TIMEOUT_MS = 60_000

const noNames = nameLookup([])

const WATCH_LIMIT = { path_type: 'SuccessOrTimeoutPath', limit: { value: 1, unit: 'DAYS' } }
const watchChild = (nodeId: string) => [{ node_id: nodeId, limit_millis: DAY, deadline_branch: 'timeout', graph_version: 1 }]

/** Setup S, watch W under S on next, End E1 under W on success: the node analytics worked example. */
const WORKED_NODES: NodeFixture[] = [
  { id: 'S', type: 'setup', trigger: { kind: 'event', event: 'view_product' } },
  { id: 'W', type: 'watch', parent: { id: 'S', branch: 'next' }, trigger: { kind: 'event', event: 'add_to_cart' }, paths: WATCH_LIMIT },
  { id: 'E1', type: 'end', parent: { id: 'W', branch: 'success' } },
]

function analytics(campaignId: string, nodeRows: Rows, analyticsRows: Rows) {
  const nodes = nodesByCampaign(nodeRows).get(campaignId) ?? []
  return assembleNodeAnalytics(nodes, analyticsRows, noNames).map(({ node, ...counts }) => ({ id: node.id, ...counts }))
}

function waiting(steps: WaitingStep[]) {
  return steps.map(({ node, ...step }) => ({ nodeId: node.id, ...step }))
}

function waitingSteps(nodeRows: Rows, waitingRows: Rows): WaitingStep[] {
  return assembleWaitingSteps(parseWaitingRows(waitingRows), nodesByCampaign(nodeRows), noNames)
}

type Counts = Omit<NodeAnalytics, 'node'> & { id: string }

describe('the node analytics worked example', () => {
  let nodeRows: Rows, analyticsRows: Rows, removedRows: Rows, waitingRows: Rows

  beforeAll(() => {
    const setup = journeySql('worked', WORKED_NODES, [
      { canon: 'p1', entry: 'e1', node: 'S', branch: 'next', at: T0 + HOUR, type: 'setup', children: watchChild('W') },
      { canon: 'p1', entry: 'e1', node: 'W', branch: 'success', at: T0 + 2 * HOUR, type: 'watch' },
      { canon: 'p1', entry: 'e1', node: 'E1', branch: 'next', at: T0 + 2 * HOUR, type: 'end' },
      { canon: 'p2', entry: 'e1', node: 'S', branch: 'next', at: T0 + HOUR, type: 'setup', children: watchChild('W') },
      { canon: 'p2', entry: 'e1', node: 'W', branch: 'timeout', at: T0 + DAY + HOUR, type: 'watch' },
      { canon: 'p3', entry: 'e1', node: 'S', branch: 'next', at: T0 + 3 * HOUR, type: 'setup', children: watchChild('W') },
    ])
    ;[nodeRows, analyticsRows, removedRows, waitingRows] = runPostgres(setup, [
      campaignNodesQuery(['worked']),
      nodeAnalyticsQuery('worked', SPAN),
      removedStepsQuery('worked', SPAN),
      waitingStepsQuery('p3'),
    ])
  }, POSTGRES_TIMEOUT_MS)

  it('counts Entered, Completed, Waiting, and the split of each node, completions after the range included', () => {
    expect(analytics('worked', nodeRows, analyticsRows)).toEqual<Counts[]>([
      { id: 'S', label: 'Start: view_product', depth: 0, entered: 3, completed: 3, waiting: 0, split: [{ branch: 'next', entries: 3 }] },
      {
        id: 'W',
        label: 'Wait for add_to_cart, 1 day',
        depth: 1,
        entered: 3,
        completed: 2,
        waiting: 1,
        split: [
          { branch: 'success', entries: 1 },
          { branch: 'timeout', entries: 1 },
        ],
      },
      { id: 'E1', label: 'End', depth: 2, entered: 1, completed: 1, waiting: 0, split: [{ branch: 'next', entries: 1 }] },
    ])
    expect(parseRemovedSteps(removedRows)).toEqual([])
  })

  it("shows W as entry 3's waiting step", () => {
    expect(waiting(waitingSteps(nodeRows, waitingRows))).toEqual([
      { nodeId: 'W', campaignId: 'worked', entryId: 'e1', label: 'Wait for add_to_cart, 1 day', deadline: T0 + 3 * HOUR + DAY },
    ])
  })
})

describe('a multi-branch check where one entry fired two branches', () => {
  let nodeRows: Rows, analyticsRows: Rows

  beforeAll(() => {
    const setup = journeySql(
      'multi',
      [
        { id: 'S', type: 'setup', trigger: { kind: 'event', event: 'purchase' } },
        {
          id: 'M',
          type: 'check',
          parent: { id: 'S', branch: 'next' },
          trigger: { kind: 'event', event: 'purchase' },
          paths: { path_type: 'MultiBranchPath', branches: [{ key: 'vip' }, { key: 'regular' }] },
        },
        { id: 'M-vip-end', type: 'end', parent: { id: 'M', branch: 'vip' } },
        { id: 'M-regular-end', type: 'end', parent: { id: 'M', branch: 'regular' } },
      ],
      [
        { canon: 'p1', entry: 'e1', node: 'S', branch: 'next', at: T0, type: 'setup' },
        { canon: 'p1', entry: 'e1', node: 'M', branch: 'vip', at: T0 + HOUR, type: 'check' },
        { canon: 'p1', entry: 'e1', node: 'M', branch: 'regular', at: T0 + HOUR, type: 'check' },
        { canon: 'p1', entry: 'e1', node: 'M-vip-end', branch: 'next', at: T0 + HOUR, type: 'end' },
        { canon: 'p1', entry: 'e1', node: 'M-regular-end', branch: 'next', at: T0 + HOUR, type: 'end' },
      ],
    )
    ;[nodeRows, analyticsRows] = runPostgres(setup, [campaignNodesQuery(['multi']), nodeAnalyticsQuery('multi', null)])
  }, POSTGRES_TIMEOUT_MS)

  it('counts the entry once in Completed and once on each branch, in saved branch order', () => {
    const check = analytics('multi', nodeRows, analyticsRows).find((node) => node.id === 'M')

    expect(check).toMatchObject({
      entered: 1,
      completed: 1,
      waiting: 0,
      split: [
        { branch: 'vip', entries: 1 },
        { branch: 'regular', entries: 1 },
      ],
    })
  })
})

describe('an entry whose parent transition is before the range', () => {
  let nodeRows: Rows, analyticsRows: Rows

  beforeAll(() => {
    const nodes: NodeFixture[] = [...WORKED_NODES, { id: 'E2', type: 'end', parent: { id: 'W', branch: 'timeout' } }]
    const setup = journeySql('range', nodes, [
      { canon: 'p1', entry: 'e1', node: 'S', branch: 'next', at: T0 - HOUR, type: 'setup' },
      { canon: 'p1', entry: 'e1', node: 'W', branch: 'success', at: T0 + HOUR, type: 'watch' },
      { canon: 'p1', entry: 'e1', node: 'E1', branch: 'next', at: T0 + HOUR, type: 'end' },
      { canon: 'p2', entry: 'e1', node: 'S', branch: 'next', at: T0 + 2 * HOUR, type: 'setup' },
      { canon: 'p2', entry: 'e1', node: 'W', branch: 'success', at: T0 + 3 * HOUR, type: 'watch' },
      { canon: 'p2', entry: 'e1', node: 'E1', branch: 'next', at: T0 + 3 * HOUR, type: 'end' },
    ])
    ;[nodeRows, analyticsRows] = runPostgres(setup, [campaignNodesQuery(['range']), nodeAnalyticsQuery('range', SPAN)])
  }, POSTGRES_TIMEOUT_MS)

  it("leaves the entry out of the node's Entered and counts it under the node's child", () => {
    expect(analytics('range', nodeRows, analyticsRows).map(({ id, entered, completed }) => ({ id, entered, completed }))).toEqual([
      { id: 'S', entered: 1, completed: 1 },
      { id: 'W', entered: 1, completed: 1 },
      { id: 'E1', entered: 2, completed: 2 },
      { id: 'E2', entered: 0, completed: 0 },
    ])
  })

  it('shows a branch that has a current child and no entries as 0', () => {
    expect(analytics('range', nodeRows, analyticsRows).find((node) => node.id === 'W')?.split).toEqual([
      { branch: 'success', entries: 1 },
      { branch: 'timeout', entries: 0 },
    ])
  })
})

describe('All time', () => {
  let nodeRows: Rows, analyticsRows: Rows, statsRows: Rows

  beforeAll(() => {
    const setup = journeySql(
      'alltime',
      [...WORKED_NODES, { id: 'E2', type: 'end', parent: { id: 'W', branch: 'timeout' } }],
      [
        { canon: 'p1', entry: 'e1', node: 'S', branch: 'next', at: T0, type: 'setup' },
        { canon: 'p1', entry: 'e1', node: 'W', branch: 'success', at: T0 + HOUR, type: 'watch' },
        { canon: 'p1', entry: 'e1', node: 'E1', branch: 'next', at: T0 + HOUR, type: 'end' },
        { canon: 'p1', entry: 'e2', node: 'S', branch: 'next', at: T0 + 10 * DAY, type: 'setup' },
        { canon: 'p1', entry: 'e2', node: 'W', branch: 'timeout', at: T0 + 11 * DAY, type: 'watch' },
        { canon: 'p1', entry: 'e2', node: 'E2', branch: 'next', at: T0 + 11 * DAY, type: 'end' },
        { canon: 'p2', entry: 'e1', node: 'S', branch: 'next', at: T0 - 40 * DAY, type: 'setup' },
      ],
    )
    ;[nodeRows, analyticsRows, statsRows] = runPostgres(setup, [
      campaignNodesQuery(['alltime']),
      nodeAnalyticsQuery('alltime', null),
      { text: 'SELECT node_id, user_count::int AS user_count FROM campaign_node_stats WHERE campaign_id = $1', values: ['alltime'] },
    ])
  }, POSTGRES_TIMEOUT_MS)

  it("gives each node's Completed as campaign_node_stats counts it, two entries of one person twice", () => {
    const completed = Object.fromEntries(analytics('alltime', nodeRows, analyticsRows).map(({ id, completed }) => [id, completed]))
    const userCount = Object.fromEntries(statsRows.map((row) => [row.node_id, row.user_count]))

    expect(completed).toEqual({ S: 3, W: 2, E1: 1, E2: 1 })
    expect(completed).toEqual(userCount)
  })
})

// The node analytics query before #328: one join over every node's reach. It is the reference that
// the per-node query must agree with.
function singleJoinNodeAnalyticsQuery(campaignId: string, span: Span | null): SqlQuery {
  const range = span === null ? '' : 'AND t.event_timestamp >= $2 AND t.event_timestamp < $3'
  return {
    text: `WITH nodes AS (
  SELECT node_id, node_type, parent_node_id, parent_branch FROM campaign_nodes WHERE campaign_id = $1
),
reach AS (
  SELECT DISTINCT n.node_id, t.canon_id, t.entry_id
  FROM nodes n JOIN user_campaign_state_transitions t ON t.campaign_id = $1 AND t.node_id = n.node_id
  WHERE n.node_type = 'setup' ${range}
  UNION ALL
  SELECT n.node_id, t.canon_id, t.entry_id
  FROM nodes n JOIN user_campaign_state_transitions t
    ON t.campaign_id = $1 AND t.node_id = n.parent_node_id AND t.branch = n.parent_branch
  WHERE n.node_type <> 'setup' ${range}
)
SELECT node_id, NULL AS branch, 1 AS total, count(*)::int AS entries FROM reach GROUP BY node_id
UNION ALL
SELECT r.node_id, c.branch, 0, count(*)::int
FROM reach r LEFT JOIN user_campaign_state_transitions c
  ON c.canon_id = r.canon_id AND c.campaign_id = $1 AND c.entry_id = r.entry_id AND c.node_id = r.node_id
GROUP BY r.node_id, c.branch`,
    values: span === null ? [campaignId] : [campaignId, span.start, span.end],
  }
}

/** Setup S, a multi-branch check M, an End under M on vip, a watch W under M on regular, and an engagement G under W on timeout. */
const GENERATED_NODES: NodeFixture[] = [
  { id: 'S', type: 'setup', trigger: { kind: 'event', event: 'view_product' } },
  {
    id: 'M',
    type: 'check',
    parent: { id: 'S', branch: 'next' },
    trigger: { kind: 'event', event: 'purchase' },
    paths: { path_type: 'MultiBranchPath', branches: [{ key: 'vip' }, { key: 'regular' }] },
  },
  { id: 'M-vip-end', type: 'end', parent: { id: 'M', branch: 'vip' } },
  { id: 'W', type: 'watch', parent: { id: 'M', branch: 'regular' }, trigger: { kind: 'event', event: 'add_to_cart' }, paths: WATCH_LIMIT },
  { id: 'W-success-end', type: 'end', parent: { id: 'W', branch: 'success' } },
  { id: 'G', type: 'engagement', parent: { id: 'W', branch: 'timeout' }, action: { channel: 'email' } },
]

/**
 * 150 people with one or two entries, spread over two days around SPAN. A seeded generator decides
 * how far each entry got, so some entries wait, fire two branches of M, have a second setup branch,
 * complete a step whose parent transition is missing, or end under a removed End id.
 */
function generatedTransitions(): TransitionFixture[] {
  let seed = 328
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const transitions: TransitionFixture[] = []
  for (let person = 0; person < 150; person++) {
    for (const entry of random() < 0.3 ? ['first', 'e2'] : ['first']) {
      let at = T0 - DAY + Math.floor(random() * 2 * DAY)
      const add = (node: string, branch: string, type: string) => {
        transitions.push({ canon: `p${person}`, entry, node, branch, at, type })
        at += Math.floor(random() * 6 * HOUR)
      }
      const skipsSetup = random() < 0.05
      if (!skipsSetup) add('S', 'next', 'setup')
      if (!skipsSetup && random() < 0.1) add('S', 'retry', 'setup')
      if (random() < 0.15) continue
      const roll = random()
      const branches = roll < 0.2 ? ['vip', 'regular'] : roll < 0.5 ? ['vip'] : ['regular']
      for (const branch of branches) add('M', branch, 'check')
      if (branches.includes('vip') && random() < 0.9) add(random() < 0.2 ? 'M-vip-0-end' : 'M-vip-end', 'next', 'end')
      if (!branches.includes('regular') || random() < 0.2) continue
      const watch = random() < 0.5 ? 'success' : 'timeout'
      add('W', watch, 'watch')
      if (random() < 0.3) continue
      if (watch === 'success') add('W-success-end', 'next', 'end')
      else add('G', 'next', 'engagement')
    }
  }
  return transitions
}

describe('a generated journey', () => {
  let nodeRows: Rows, inSpan: Rows, inSpanReference: Rows, allTime: Rows, allTimeReference: Rows

  beforeAll(() => {
    const setup = journeySql('generated', GENERATED_NODES, generatedTransitions())
    ;[nodeRows, inSpan, inSpanReference, allTime, allTimeReference] = runPostgres(setup, [
      campaignNodesQuery(['generated']),
      nodeAnalyticsQuery('generated', SPAN),
      singleJoinNodeAnalyticsQuery('generated', SPAN),
      nodeAnalyticsQuery('generated', null),
      singleJoinNodeAnalyticsQuery('generated', null),
    ])
  }, POSTGRES_TIMEOUT_MS)

  it('gives the counts of one join over every node, in a range and over All time', () => {
    const generated = (rows: Rows) => analytics('generated', nodeRows, rows)

    expect(generated(inSpan)).toEqual(generated(inSpanReference))
    expect(generated(allTime)).toEqual(generated(allTimeReference))
    expect(generated(inSpan).filter((node) => node.id !== 'S').every((node) => node.entered > 0 && node.waiting > 0)).toBe(true)
  })
})

describe('transitions under a node id that is not a current node', () => {
  let nodeRows: Rows, removedInSpan: Rows, removedAllTime: Rows, waitingRows: Rows

  beforeAll(() => {
    const nodes: NodeFixture[] = [...WORKED_NODES.slice(0, 2), { id: 'W-success-end', type: 'end', parent: { id: 'W', branch: 'success' } }]
    const endedUnderOldId = (canon: string, at: number) =>
      [
        { node: 'S', branch: 'next', type: 'setup' },
        { node: 'W', branch: 'success', type: 'watch' },
        { node: 'W-success-0-end', branch: 'next', type: 'end' },
      ].map((t) => ({ ...t, canon, entry: 'e1', at }))
    const setup = journeySql('removed', nodes, [...endedUnderOldId('p1', T0 + 2 * HOUR), ...endedUnderOldId('p2', T0 - 2 * DAY)])
    ;[nodeRows, removedInSpan, removedAllTime, waitingRows] = runPostgres(setup, [
      campaignNodesQuery(['removed']),
      removedStepsQuery('removed', SPAN),
      removedStepsQuery('removed', null),
      waitingStepsQuery('p1'),
    ])
  }, POSTGRES_TIMEOUT_MS)

  it('lists the id as a removed step with its entries in the range', () => {
    expect(parseRemovedSteps(removedInSpan)).toEqual([
      { nodeId: 'W-success-0-end', nodeType: 'end', label: 'Removed step (end)', entries: 1 },
    ])
    expect(parseRemovedSteps(removedAllTime)).toEqual([
      { nodeId: 'W-success-0-end', nodeType: 'end', label: 'Removed step (end)', entries: 2 },
    ])
  })

  it('never makes it a waiting step, while the current End under the same branch is one', () => {
    expect(waiting(waitingSteps(nodeRows, waitingRows))).toEqual([
      { nodeId: 'W-success-end', campaignId: 'removed', entryId: 'e1', label: 'End', deadline: null },
    ])
  })
})
