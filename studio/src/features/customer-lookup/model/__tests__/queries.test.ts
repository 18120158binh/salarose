/** @jest-environment node */
import { nameLookup, campaignNodesQuery, nodesByCampaign, parseWaitingRows, assembleWaitingSteps, waitingStepsQuery } from '@/features/journey-analytics/model/queries'
import { journeySql, runPostgres, type NodeFixture } from '@/features/journey-analytics/model/testing/pg'
import { assembleEntries, type Entry } from '../entries'
import {
  entriesQuery,
  identitiesQuery,
  metricsQuery,
  parseIdentities,
  parseMetricRows,
  parsePerson,
  parseSearchRows,
  personQuery,
  searchQuery,
  type Shown,
} from '../queries'
import { messagesQuery, parseMessages } from '../messages'
import { searchText, type SearchText } from '../search'

const DAY = 86_400_000

type IdentityFixture = { device: string; user: string | null; canon: string; created?: string; updated?: string }

function literal(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

function identitySql(rows: readonly IdentityFixture[]): string {
  return rows
    .map(
      (row) =>
        `INSERT INTO identity_graph (domain_userid, user_id, canon_id, created_at, updated_at) VALUES (${literal(row.device)}, ${literal(row.user)}, ${literal(row.canon)}, ${literal(row.created ?? '2026-10-01T00:00:00Z')}, ${literal(row.updated ?? '2026-10-01T00:00:00Z')});`,
    )
    .join('\n')
}

function metricSql(canon: string, id: string, fn: string, buckets: unknown, opts: { field?: string; mode?: string; clock?: number } = {}): string {
  return `INSERT INTO user_metric_definitions (id, name, display_name, event_name, agg_operator, agg_field, processing_mode, retention_ms)
VALUES (${literal(id)}, ${literal(id)}, ${literal(id)}, 'add_to_cart', ${literal(fn)}, ${literal(opts.field ?? null)}, ${literal(opts.mode ?? 'LIVE')}, ${30 * DAY});
INSERT INTO user_metrics (canon_id, metric_id, series_clock, buckets) VALUES (${literal(canon)}, ${literal(id)}, ${opts.clock ?? 1_000_000}, ${literal(JSON.stringify(buckets))}::jsonb);`
}

const P1_IDENTITIES = identitySql([
  { device: 'a1', user: 'usr_1001', canon: 'P1' },
  { device: 'b2', user: null, canon: 'P1' },
])

function typed(text: string): SearchText {
  return searchText(text) ?? { exact: text, userIds: [text] }
}

function search(setup: string, text: string): string[] {
  const [rows] = runPostgres(setup, [searchQuery(typed(text))])
  return parseSearchRows(rows).map((person) => person.canonId)
}

describe('search (CUS-FR-01, CUS-FR-02)', () => {
  it.each(['usr_1001', 'a1', 'b2', 'P1'])('finds P1 by %s', (text) => {
    expect(search(P1_IDENTITIES, text)).toEqual(['P1'])
  })

  it('matches exactly, so usr_100 finds nobody', () => {
    expect(search(P1_IDENTITIES, 'usr_100')).toEqual([])
  })

  it('finds a user id saved as a lower-case email or a phone from the way a marketer types it (CUS-FR-11)', () => {
    const setup = identitySql([
      { device: 'e1', user: 'lan@example.com', canon: 'PE' },
      { device: 'p1', user: '+84912345678', canon: 'PP' },
      { device: 'p2', user: '0987654321', canon: 'PQ' },
    ])
    const [byEmail, byLocalPhone, byIntlPhone, byDeviceCase] = runPostgres(setup, [
      searchQuery(typed(' Lan@Example.com ')),
      searchQuery(typed('0912 345 678')),
      searchQuery(typed('+84 987 654 321')),
      searchQuery(typed('E1')),
    ])
    expect(parseSearchRows(byEmail).map((p) => p.canonId)).toEqual(['PE'])
    expect(parseSearchRows(byLocalPhone).map((p) => p.canonId)).toEqual(['PP'])
    expect(parseSearchRows(byIntlPhone).map((p) => p.canonId)).toEqual(['PQ'])
    expect(parseSearchRows(byDeviceCase)).toEqual([])
  })

  it('lists both people when one user id was seen with devices of two people, newest last seen first', () => {
    const setup = identitySql([
      { device: 'd1', user: 'usr_7', canon: 'P7a', updated: '2026-10-02T00:00:00Z' },
      { device: 'd2', user: 'usr_7', canon: 'P7b', updated: '2026-10-05T00:00:00Z' },
    ])
    const [rows] = runPostgres(setup, [searchQuery(typed('usr_7'))])
    expect(parseSearchRows(rows)).toEqual([
      { canonId: 'P7b', newestUserId: 'usr_7', devices: 1, firstSeen: Date.parse('2026-10-01T00:00:00Z'), lastSeen: Date.parse('2026-10-05T00:00:00Z') },
      { canonId: 'P7a', newestUserId: 'usr_7', devices: 1, firstSeen: Date.parse('2026-10-01T00:00:00Z'), lastSeen: Date.parse('2026-10-02T00:00:00Z') },
    ])
  })

  it('finds a person id that only has transitions or metrics, and never the empty person id', () => {
    const setup = [
      journeySql('cmp_1', [{ id: 's', type: 'setup' }], [{ canon: 'P9', entry: 'first', node: 's', branch: 'next', at: 1, type: 'setup' }]),
      metricSql('P8', 'm_1', 'COUNT', []),
      identitySql([{ device: 'x', user: '', canon: '' }]),
    ].join('\n')
    expect(search(setup, 'P9')).toEqual(['P9'])
    expect(search(setup, 'P8')).toEqual(['P8'])
    expect(search(setup, '')).toEqual([])
  })
})

describe('person (CUS-FR-04)', () => {
  it('takes the title from the user id updated last, and counts devices, first seen, and last seen', () => {
    const setup = identitySql([
      { device: 'd2', user: 'usr_1', canon: 'P', created: '2026-10-01T00:00:00Z', updated: '2026-11-07T00:00:00Z' },
      { device: 'd1', user: 'usr_2', canon: 'P', created: '2026-10-03T00:00:00Z', updated: '2026-11-08T00:00:00Z' },
      { device: 'd3', user: null, canon: 'P', created: '2026-09-30T00:00:00Z', updated: '2026-11-09T00:00:00Z' },
    ])
    const [rows] = runPostgres(setup, [personQuery('P')])
    expect(parsePerson(rows, 'P')).toEqual({
      canonId: 'P',
      newestUserId: 'usr_2',
      devices: 3,
      firstSeen: Date.parse('2026-09-30T00:00:00Z'),
      lastSeen: Date.parse('2026-11-09T00:00:00Z'),
    })
  })

  it('opens a person with only metrics, with no user id and no devices, and finds nobody for an unknown id', () => {
    const [known, unknown] = runPostgres(metricSql('P', 'm_1', 'COUNT', []), [personQuery('P'), personQuery('nobody')])
    expect(parsePerson(known, 'P')).toEqual({ canonId: 'P', newestUserId: null, devices: 0, firstSeen: null, lastSeen: null })
    expect(parsePerson(unknown, 'nobody')).toBeNull()
  })
})

describe('identities (CUS-FR-05)', () => {
  it('shows the 50 newest of 60 identities and counts 10 more', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      device: `d${String(i).padStart(2, '0')}`,
      user: null,
      canon: 'P',
      updated: new Date(Date.parse('2026-10-01T00:00:00Z') + i * DAY).toISOString(),
    }))
    const [result] = runPostgres(identitySql(rows), [identitiesQuery('P')])
    const shown = parseIdentities(result)
    expect(shown.rows).toHaveLength(50)
    expect(shown.rows[0].deviceId).toBe('d59')
    expect(shown.rows[49].deviceId).toBe('d10')
    expect(shown.more).toBe(10)
  })
})

const NO_NAMES = nameLookup([])

/** Runs the entries pipeline as loadEntries does, for one campaign. */
function entries(setup: string, canon: string, campaignIds: string[]): Shown<Entry> {
  const [rows, nodeRows, waitingRows] = runPostgres(setup, [entriesQuery(canon), campaignNodesQuery(campaignIds), waitingStepsQuery(canon)])
  const nodes = nodesByCampaign(nodeRows)
  return assembleEntries(rows, nodes, assembleWaitingSteps(parseWaitingRows(waitingRows), nodes, NO_NAMES), NO_NAMES)
}

const CART: NodeFixture[] = [
  { id: 'n1', type: 'setup', trigger: { kind: 'event', event: 'add_to_cart' } },
  { id: 'n2', type: 'check', parent: { id: 'n1', branch: 'next' }, trigger: { event: 'purchase' } },
  { id: 'a3', type: 'engagement', parent: { id: 'n2', branch: 'no' }, action: { type: 'push', title: 'Still thinking about it?' } },
  { id: 'n4', type: 'watch', parent: { id: 'n2', branch: 'yes' }, trigger: { event: 'add_to_cart' }, paths: { limit: { value: 1, unit: 'DAYS' } } },
  { id: 'n5', type: 'end', parent: { id: 'a3', branch: 'next' } },
]

describe('journeys (CUS-FR-06, CUS-FR-07)', () => {
  const checkAt = Date.parse('2026-11-09T19:40:00Z')

  it('lists two entries of one journey as two rows, newest entered first', () => {
    const shown = entries(
      journeySql('cart', CART, [
        { canon: 'P', entry: 'e1', node: 'n1', branch: 'next', at: 1000, type: 'setup' },
        { canon: 'P', entry: 'e2', node: 'n1', branch: 'next', at: 2000, type: 'setup' },
      ]),
      'P',
      ['cart'],
    )
    expect(shown.rows.map((entry) => [entry.entryId, entry.entered, entry.journey?.name])).toEqual([
      ['e2', 2000, 'cart'],
      ['e1', 1000, 'cart'],
    ])
    expect(shown.more).toBe(0)
  })

  it('picks the engagement over the check that shares its event time and write time', () => {
    const shown = entries(
      journeySql('cart', CART, [
        { canon: 'P', entry: 'e1', node: 'n1', branch: 'next', at: 1000, type: 'setup' },
        { canon: 'P', entry: 'e1', node: 'n2', branch: 'no', at: 2000, type: 'check' },
        { canon: 'P', entry: 'e1', node: 'a3', branch: 'next', at: 2000, type: 'engagement' },
      ]),
      'P',
      ['cart'],
    )
    expect(shown.rows[0].lastStep).toBe('Push "Still thinking about it?"')
  })

  it('picks the latest write time before depth', () => {
    const shown = entries(
      `${journeySql('cart', CART, [
        { canon: 'P', entry: 'e1', node: 'n2', branch: 'no', at: 2000, type: 'check' },
        { canon: 'P', entry: 'e1', node: 'a3', branch: 'next', at: 2000, type: 'engagement' },
      ])}
UPDATE user_campaign_state_transitions SET transitioned_at = transitioned_at + interval '1 second' WHERE node_id = 'n2';`,
      'P',
      ['cart'],
    )
    expect(shown.rows[0].lastStep).toBe('Check: purchase')
  })

  it('shows a waiting watch with its deadline from the check transition', () => {
    const shown = entries(
      journeySql('cart', CART, [
        { canon: 'P', entry: 'e1', node: 'n1', branch: 'next', at: checkAt - 1000, type: 'setup' },
        { canon: 'P', entry: 'e1', node: 'n2', branch: 'yes', at: checkAt, type: 'check', children: [{ node_id: 'n4', limit_millis: DAY }] },
      ]),
      'P',
      ['cart'],
    )
    expect(shown.rows[0].now).toEqual({ kind: 'waiting', steps: [{ label: 'Wait for add_to_cart, 1 day', deadline: checkAt + DAY }] })
  })

  it('shows a waiting watch without a deadline when the children do not parse', () => {
    const shown = entries(
      journeySql('cart', CART, [{ canon: 'P', entry: 'e1', node: 'n2', branch: 'yes', at: checkAt, type: 'check', children: 'garbled' }]),
      'P',
      ['cart'],
    )
    expect(shown.rows[0].now).toEqual({ kind: 'waiting', steps: [{ label: 'Wait for add_to_cart, 1 day', deadline: null }] })
  })

  it('reads Finished when the last transition is an End node', () => {
    const shown = entries(
      journeySql('cart', CART, [
        { canon: 'P', entry: 'e1', node: 'n1', branch: 'next', at: 1000, type: 'setup' },
        { canon: 'P', entry: 'e1', node: 'n2', branch: 'no', at: 2000, type: 'check' },
        { canon: 'P', entry: 'e1', node: 'a3', branch: 'next', at: 2000, type: 'engagement' },
        { canon: 'P', entry: 'e1', node: 'n5', branch: 'next', at: 2000, type: 'end' },
      ]),
      'P',
      ['cart'],
    )
    expect(shown.rows[0]).toMatchObject({ lastStep: 'End', now: { kind: 'finished' } })
  })

  it('reads Journey deleted with no current nodes, and Deleted journey with no campaign row', () => {
    const setup = `${journeySql('cart', CART, [{ canon: 'P', entry: 'e1', node: 'n2', branch: 'yes', at: 2000, type: 'check' }])}
DELETE FROM campaign_nodes; DELETE FROM campaigns;`
    const [entry] = entries(setup, 'P', ['cart']).rows
    expect(entry).toMatchObject({ journey: null, lastStep: 'Removed step (check)', now: { kind: 'journey-deleted' } })
  })

  it('takes Entered from the setup transition, or the earliest transition without one', () => {
    const shown = entries(
      journeySql('cart', CART, [
        { canon: 'P', entry: 'e1', node: 'n2', branch: 'no', at: 500, type: 'check' },
        { canon: 'P', entry: 'e1', node: 'n1', branch: 'next', at: 900, type: 'setup' },
        { canon: 'P', entry: 'e2', node: 'n2', branch: 'no', at: 3000, type: 'check' },
        { canon: 'P', entry: 'e2', node: 'a3', branch: 'next', at: 3000, type: 'engagement' },
      ]),
      'P',
      ['cart'],
    )
    expect(shown.rows.map((entry) => [entry.entryId, entry.entered])).toEqual([
      ['e2', 3000],
      ['e1', 900],
    ])
  })
})

describe('metrics (CUS-FR-08)', () => {
  const minute = (start: number, count: number, extra: object = {}) => ({ size: 'MINUTE', start, count, ...extra })

  function metrics(setup: string) {
    const [rows] = runPostgres(setup, [metricsQuery('P')])
    return parseMetricRows(rows)
  }

  it('sums the counts of every bucket at the series clock', () => {
    const [row] = metrics(metricSql('P', 'm_count', 'COUNT', [minute(0, 2), minute(60_000, 3), minute(120_000, 2)], { clock: 150_000 }))
    expect(row).toEqual({ metricId: 'm_count', label: { event: 'add_to_cart', measure: 'number of times, last 30 days', system: 'add_to_cart · COUNT' }, asOf: 150_000, paused: false, value: { kind: 'value', value: 7 } })
  })

  it('names the event by its catalog display name when it has one', () => {
    const setup = `${metricSql('P', 'm_count', 'COUNT', [minute(0, 1)])}
INSERT INTO user_events (id, event_name, display_name) VALUES ('ev_1', 'add_to_cart', 'Added to cart');`
    const [row] = metrics(setup)
    expect(row.label).toEqual({ event: 'Added to cart', measure: 'number of times, last 30 days', system: 'add_to_cart · COUNT' })
  })

  it('marks a series that does not parse as not available, and still shows the others', () => {
    const rows = metrics(
      [metricSql('P', 'm_bad', 'COUNT', [{ size: 'WEEK', start: 0, count: 1 }], { clock: 2 }), metricSql('P', 'm_ok', 'COUNT', [minute(0, 1)], { clock: 1 })].join('\n'),
    )
    expect(rows.map((row) => [row.metricId, row.value])).toEqual([
      ['m_bad', { kind: 'not-available' }],
      ['m_ok', { kind: 'value', value: 1 }],
    ])
  })

  it('hides MEDIAN with its occurrence count, names the attribute, and marks a PAUSED definition', () => {
    const [row] = metrics(metricSql('P', 'm_med', 'MEDIAN', [minute(0, 4, { quantiles: 'AAAA' })], { field: 'order.total', mode: 'PAUSED' }))
    expect(row).toMatchObject({ label: { event: 'add_to_cart', measure: 'median of order.total, last 30 days', system: 'add_to_cart · MEDIAN' }, paused: true, value: { kind: 'not-shown', occurrences: 4 } })
  })
})

describe('messages (CUS-FR-13)', () => {
  type Sent = { canon?: string; campaign: string; node: string; type?: string; at: number; action?: object | string }

  function transitionSql(rows: readonly Sent[]): string {
    return rows
      .map((row) => {
        const action = row.action === undefined ? 'NULL' : literal(typeof row.action === 'string' ? row.action : JSON.stringify(row.action))
        return `INSERT INTO user_campaign_state_transitions (canon_id, campaign_id, entry_id, node_id, branch, event_timestamp, node_type, action_json)
VALUES (${literal(row.canon ?? 'P')}, ${literal(row.campaign)}, 'first', ${literal(row.node)}, 'next', ${row.at}, ${literal(row.type ?? 'engagement')}, ${action});`
      })
      .join('\n')
  }

  function messages(setup: string) {
    const [rows] = runPostgres(setup, [messagesQuery('P')])
    return parseMessages(rows)
  }

  it('lists only engagement transitions, newest first, with the channel, the title or the start of the body, and the journey', () => {
    const body = 'Your cart still holds the Hội An lamp and two more things you picked last night before bed.'
    const setup = [
      `INSERT INTO campaigns (id, name, status, root) VALUES ('cart', 'Cart abandonment', 'active', '{}');`,
      transitionSql([
        { campaign: 'cart', node: 's', type: 'setup', at: 500 },
        { campaign: 'cart', node: 'n_push', at: 1000, action: { type: 'push', title: 'Still thinking about it?', body: 'Come back' } },
        { campaign: 'cart', node: 'n_sms', at: 3000, action: { type: 'sms', body } },
        { campaign: 'gone', node: 'n_mail', at: 2000, action: { type: 'email', subject: 'Welcome' } },
        { campaign: 'cart', node: 'n_bad', at: 4000, action: 'not json' },
        { canon: 'Q', campaign: 'cart', node: 'n_push', at: 5000, action: { type: 'push', title: 'Someone else' } },
      ]),
    ].join('\n')
    const shown = messages(setup)
    expect(shown.rows.map(({ title, journeyName, sentAt }) => ({ title, journeyName, sentAt }))).toEqual([
      { title: 'Engagement', journeyName: 'Cart abandonment', sentAt: 4000 },
      { title: `SMS “${body.slice(0, 60).trimEnd()}…”`, journeyName: 'Cart abandonment', sentAt: 3000 },
      { title: 'Email “Welcome”', journeyName: null, sentAt: 2000 },
      { title: 'Push “Still thinking about it?”', journeyName: 'Cart abandonment', sentAt: 1000 },
    ])
    expect(shown.more).toBe(0)
  })

  it('shows the 50 newest of 55 messages and counts 5 more', () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({ campaign: 'cart', node: `n${i}`, at: i, action: { type: 'push', title: `m${i}` } }))
    const shown = messages(transitionSql(rows))
    expect(shown.rows).toHaveLength(50)
    expect(shown.rows[0].title).toBe('Push “m54”')
    expect(shown.more).toBe(5)
  })
})
