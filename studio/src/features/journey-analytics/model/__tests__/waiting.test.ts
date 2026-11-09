/** @jest-environment node */

import { referencedNames } from '../labels'
import {
  assembleWaitingSteps,
  campaignNodesQuery,
  nameLookup,
  namesQuery,
  nodesByCampaign,
  parseWaitingRows,
  peopleWaitingQuery,
  waitingCampaignIds,
  waitingStepsQuery,
  type WaitingStep,
} from '../queries'
import { journeySql, runPostgres, type NodeFixture, type Rows } from '../testing/pg'

const DAY = 86_400_000
const CHECKED_AT = Date.UTC(2026, 10, 9, 12, 40)
const POSTGRES_TIMEOUT_MS = 60_000

const DEADLINE_NODES: NodeFixture[] = [
  { id: 'S', type: 'setup', trigger: { kind: 'event', event: 'view_product' } },
  { id: 'C', type: 'check', parent: { id: 'S', branch: 'next' }, trigger: { kind: 'event', event: 'purchase' } },
  {
    id: 'W2',
    type: 'watch',
    parent: { id: 'C', branch: 'yes' },
    trigger: { kind: 'event', event: 'add_to_cart' },
    paths: { path_type: 'SuccessOrTimeoutPath', limit: { value: 1, unit: 'DAYS' } },
  },
  { id: 'W2-success-end', type: 'end', parent: { id: 'W2', branch: 'success' } },
  { id: 'W2-timeout-end', type: 'end', parent: { id: 'W2', branch: 'timeout' } },
]

const CATALOG = `INSERT INTO user_events (id, event_name, display_name) VALUES
  ('ev_1', 'add_to_cart', 'Add to cart'), ('ev_2', 'view_product', 'View product'), ('ev_3', 'checkout', 'Checkout');`

describe("a person's waiting steps", () => {
  let nodeRows: Rows, nameRows: Rows, waitingP1: Rows, waitingP2: Rows, peopleDeadline: Rows, peopleSecond: Rows

  beforeAll(() => {
    const setup = [
      CATALOG,
      journeySql('deadline', DEADLINE_NODES, [
        { canon: 'p1', entry: 'e1', node: 'S', branch: 'next', at: CHECKED_AT - DAY, type: 'setup' },
        {
          canon: 'p1',
          entry: 'e1',
          node: 'C',
          branch: 'yes',
          at: CHECKED_AT,
          type: 'check',
          children: [{ node_id: 'W2', limit_millis: 86_400_000, deadline_branch: 'timeout', graph_version: 1 }],
        },
        { canon: 'p1', entry: 'e2', node: 'S', branch: 'next', at: CHECKED_AT - DAY, type: 'setup' },
        { canon: 'p1', entry: 'e2', node: 'C', branch: 'yes', at: CHECKED_AT, type: 'check', children: { node_id: 'W2' } },
        { canon: 'p2', entry: 'e1', node: 'S', branch: 'next', at: CHECKED_AT, type: 'setup' },
      ]),
      journeySql(
        'second',
        [
          { id: 'S', type: 'setup', trigger: { kind: 'event', event: 'checkout' } },
          { id: 'D', type: 'watch', parent: { id: 'S', branch: 'next' }, paths: { path_type: 'DelayPath', limit: { value: 2, unit: 'HOURS' } } },
        ],
        [
          {
            canon: 'p1',
            entry: 'first',
            node: 'S',
            branch: 'next',
            at: CHECKED_AT,
            type: 'setup',
            children: [{ node_id: 'D', limit_millis: 7_200_000, deadline_branch: 'next', graph_version: 1 }],
          },
        ],
      ),
    ].join('\n')
    ;[nodeRows, nameRows, waitingP1, waitingP2, peopleDeadline, peopleSecond] = runPostgres(setup, [
      campaignNodesQuery(['deadline', 'second']),
      namesQuery({ events: ['add_to_cart', 'checkout', 'purchase', 'view_product'], segments: [] }),
      waitingStepsQuery('p1'),
      waitingStepsQuery('p2'),
      peopleWaitingQuery('deadline'),
      peopleWaitingQuery('second'),
    ])
  }, POSTGRES_TIMEOUT_MS)

  function steps(waitingRows: Rows): WaitingStep[] {
    return assembleWaitingSteps(parseWaitingRows(waitingRows), nodesByCampaign(nodeRows), nameLookup(nameRows))
  }

  it("dates a waiting watch from its parent's transition, and leaves it waiting with no deadline when children do not parse", () => {
    expect(steps(waitingP1).map(({ node, ...step }) => ({ nodeId: node.id, ...step }))).toEqual([
      { nodeId: 'W2', campaignId: 'deadline', entryId: 'e1', label: 'Wait for Add to cart, 1 day', deadline: CHECKED_AT + DAY },
      { nodeId: 'W2', campaignId: 'deadline', entryId: 'e2', label: 'Wait for Add to cart, 1 day', deadline: null },
      { nodeId: 'D', campaignId: 'second', entryId: 'first', label: 'Wait 2 hours', deadline: CHECKED_AT + 2 * 3_600_000 },
    ])
  })

  it('counts a person with two waiting entries once in the people a delete takes out (CMP-FR-19)', () => {
    expect(peopleDeadline).toEqual([{ people: 2 }])
    expect(peopleSecond).toEqual([{ people: 1 }])
  })

  it('gives a waiting check no deadline', () => {
    expect(steps(waitingP2).map(({ node, ...step }) => ({ nodeId: node.id, ...step }))).toEqual([
      { nodeId: 'C', campaignId: 'deadline', entryId: 'e1', label: 'Check: purchase', deadline: null },
    ])
  })

  it('loads the nodes and the display names of exactly the campaigns and events the steps need', () => {
    expect(waitingCampaignIds(parseWaitingRows(waitingP1))).toEqual(['deadline', 'second'])
    expect(referencedNames([...nodesByCampaign(nodeRows).values()].flat())).toEqual({
      events: ['add_to_cart', 'checkout', 'purchase', 'view_product'],
      segments: [],
    })
  })
})
