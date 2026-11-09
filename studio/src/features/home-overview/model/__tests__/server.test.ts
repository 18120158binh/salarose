/** @jest-environment node */
import { computeRange, parseTimeZone } from '@/shared/lib/time-range'
import { DeadLetterReadError } from '@/features/data-health/model/deadLetterReader'
import { TestPostgres, campaignsSql, transitionsSql, usersSql, type TransitionFixture } from '../__fixtures__/pg'
import { entriesKpi, lagKpi, messagesKpi, watchKpi } from '../home'
import { activeJourneys, engineLag, kpiCounts, pipelineHealth, recentJourneys } from '../server'

jest.mock('server-only', () => ({}))

const mockPg = new TestPostgres()
const mockStatements: string[] = []
jest.mock('@/lib/db', () => ({
  readOnly: (_timeoutMs: number, work: (run: (query: { text: string; values: unknown[] }) => Promise<unknown>) => unknown) =>
    work((query) => {
      mockStatements.push(query.text)
      return mockPg.query(query)
    }),
}))

const mockDropped = jest.fn<Promise<number>, [number]>()
jest.mock('../../../data-health/model/deadLetterServer', () => ({
  deadLetterReader: () => ({ droppedCount: (windowMs: number) => mockDropped(windowMs) }),
}))

// Booting PGlite and applying the schema takes seconds, more when every test file runs at once.
beforeAll(() => mockPg.ready, 60_000)
afterAll(() => mockPg.close())
beforeEach(() => {
  mockStatements.length = 0
  mockDropped.mockReset()
})

const zone = parseTimeZone('Asia/Ho_Chi_Minh')
const local = (wall: string) => Date.parse(`${wall}+07:00`)
const SECOND = 1_000
const HOUR = 3_600_000
const DAY = 86_400_000

let canon = 0
const t = (fixture: Omit<TransitionFixture, 'canon'> & { canon?: string }): TransitionFixture => ({ canon: `c${++canon}`, ...fixture })

describe('KPI counts by event time (HOM-FR-02)', () => {
  it('counts the worked example: 3 entries, 2 messages, watch success 67% from 2 of 3', async () => {
    const at = local('2026-11-09T10:00:00')
    const setup = transitionsSql([
      t({ node: 's', type: 'setup', branch: 'next', at }),
      t({ node: 's', type: 'setup', branch: 'next', at }),
      t({ node: 's', type: 'setup', branch: 'next', at }),
      t({ node: 'e', type: 'engagement', branch: 'next', at }),
      t({ node: 'e', type: 'engagement', branch: 'next', at }),
      t({ node: 'w', type: 'watch', branch: 'success', at }),
      t({ node: 'w', type: 'watch', branch: 'success', at }),
      t({ node: 'w', type: 'watch', branch: 'timeout', at }),
      t({ node: 'd', type: 'watch', branch: 'next', at }),
    ])
    const counts = await mockPg.scenario(setup, () => kpiCounts(computeRange('today', local('2026-11-09T18:00:00'), zone)))

    expect(entriesKpi(counts).value).toEqual({ available: true, value: '3' })
    expect(messagesKpi(counts).value).toEqual({ available: true, value: '2' })
    const watch = watchKpi(counts)
    expect(watch.value).toEqual({ available: true, value: '67%' })
    expect(watch.detail).toBe('2 of 3')
  })

  it('counts paused and deleted campaigns in the KPIs', async () => {
    const at = local('2026-11-09T10:00:00')
    const setup = [
      campaignsSql([{ id: 'CAMP-paused', name: 'Paused one', status: 'paused' }]),
      transitionsSql([
        t({ campaign: 'CAMP-paused', node: 's', type: 'setup', branch: 'next', at }),
        t({ campaign: 'CAMP-gone', node: 's', type: 'setup', branch: 'next', at }),
      ]),
    ].join('\n')
    const range = computeRange('today', local('2026-11-09T18:00:00'), zone)
    const [counts, journeys] = await mockPg.scenario(setup, () => Promise.all([kpiCounts(range), activeJourneys(range, range.current.end)]))

    expect(counts.entries.current).toBe(2)
    expect(journeys).toEqual([])
  })

  it('counts an entry on the day of its event and its lag on the day it was written', async () => {
    const setup = transitionsSql([
      t({ node: 's', type: 'setup', branch: 'next', at: local('2026-11-09T23:59:59'), written: local('2026-11-10T00:00:05') }),
    ])
    const range = computeRange('7d', local('2026-11-10T09:30:00'), zone)
    const [counts, lag] = await mockPg.scenario(setup, () => Promise.all([kpiCounts(range), engineLag(range)]))

    expect(counts.entries.days.find((d) => d.date === '2026-11-09')?.value).toBe(1)
    expect(counts.entries.days.find((d) => d.date === '2026-11-10')?.value).toBe(0)
    expect(lag.days.find((d) => d.date === '2026-11-09')?.value).toBeNull()
    expect(lag.days.find((d) => d.date === '2026-11-10')?.value).toBe(6 * SECOND)
  })

  it('shows +20% and 7 daily points for 120 entries against 100, and no sparkline for Today (HOM-FR-04)', async () => {
    const now = local('2026-11-10T09:30:00')
    const setup = transitionsSql([
      ...Array.from({ length: 120 }, (_, i) => t({ node: 's', type: 'setup', branch: 'next', at: now - HOUR - i * HOUR })),
      ...Array.from({ length: 100 }, (_, i) => t({ node: 's', type: 'setup', branch: 'next', at: now - 7 * DAY - HOUR - i * HOUR })),
    ])
    const [week, today] = await mockPg.scenario(setup, () =>
      Promise.all([kpiCounts(computeRange('7d', now, zone)), kpiCounts(computeRange('today', now, zone))]),
    )

    const entries = entriesKpi(week)
    expect(entries.value).toEqual({ available: true, value: '120' })
    expect(entries.change).toEqual({ label: '+20%', direction: 'up', tone: 'good' })
    expect(entries.trend?.points).toHaveLength(7)
    expect(entriesKpi(today).trend).toBeNull()
  })
})

describe('engine lag (HOM-FR-03)', () => {
  it('is the p95 of 0 s, 1 s, 2 s, and 30 s, leaving out a condition split written 2 days late', async () => {
    const written = local('2026-11-09T12:00:00')
    const setup = transitionsSql([
      t({ node: 's', type: 'setup', branch: 'next', at: written - 1 * SECOND, written }),
      t({ node: 's', type: 'setup', branch: 'next', at: written - 2 * SECOND, written }),
      t({ node: 's', type: 'setup', branch: 'next', at: written - 30 * SECOND, written }),
      t({ node: 'c', type: 'check', branch: 'yes', at: written + 5 * SECOND, written }),
      t({ node: 'split', type: 'segment', branch: 'yes', at: written - 2 * DAY, written }),
    ])
    const lag = await mockPg.scenario(setup, () => engineLag(computeRange('today', local('2026-11-09T18:00:00'), zone)))

    // Continuous rule over [0, 1000, 2000, 30000]: 2000 + 0.85 * 28000.
    expect(lag.current).toBeCloseTo(25_800, 6)
    expect(lagKpi(lag).value).toEqual({ available: true, value: '25 s' })
  })

  it('leaves out a delay and a watch timeout under a split whose deadline had already passed', async () => {
    const now = local('2026-11-09T18:00:00')
    const written = now - 10 * 60 * SECOND
    const setup = transitionsSql([
      t({ canon: 'p1', node: 'split', type: 'segment', branch: 'yes', at: written - 2 * DAY, written }),
      t({ canon: 'p1', node: 'delay', type: 'watch', branch: 'next', at: written - 2 * DAY + HOUR, written }),
      t({ canon: 'p2', node: 'split', type: 'segment', branch: 'yes', at: written - 2 * DAY, written }),
      t({ canon: 'p2', node: 'watch', type: 'watch', branch: 'timeout', at: written - 2 * DAY + HOUR, written }),
    ])
    const [lag, health] = await mockPg.scenario(setup, () => Promise.all([engineLag(computeRange('today', now, zone)), pipelineHealth(now)]))

    expect(lag.current).toBeNull()
    expect(lagKpi(lag).value).toEqual({ available: true, value: 'No activity' })
    expect(lagKpi(lag).change).toBeNull()
    expect(health.lag).toBeNull()
    expect(health.lastTransitionAt).toBe(written)
  })

  it('measures a watch that succeeded, and leaves out one that timed out', async () => {
    const written = local('2026-11-09T12:00:00')
    const setup = transitionsSql([
      t({ node: 'w', type: 'watch', branch: 'success', at: written - 7 * SECOND, written }),
      t({ node: 'w', type: 'watch', branch: 'timeout', at: written - 2 * HOUR, written }),
    ])
    const lag = await mockPg.scenario(setup, () => engineLag(computeRange('today', local('2026-11-09T18:00:00'), zone)))

    expect(lag.current).toBeCloseTo(7_000, 6)
  })

  it('reads each node type in its own part of a UNION ALL, so the per-type indexes apply (#304)', async () => {
    await mockPg.scenario('', () => engineLag(computeRange('today', local('2026-11-09T18:00:00'), zone)))
    const [lagSql] = mockStatements
    expect(lagSql).not.toMatch(/node_type\s+IN|node_type\s*=\s*ANY/i)
    expect(lagSql.match(/UNION ALL/g)).toHaveLength(2)
  })
})

describe('health strip (HOM-FR-08)', () => {
  it('reads no journey activity in the last hour when nothing was written in it', async () => {
    const now = local('2026-11-09T18:00:00')
    const setup = transitionsSql([t({ node: 's', type: 'setup', branch: 'next', at: now - 3 * HOUR, written: now - 2 * HOUR })])
    mockDropped.mockResolvedValue(0)
    const health = await mockPg.scenario(setup, () => pipelineHealth(now))

    expect(health.lag).toBeNull()
    expect(health.lastTransitionAt).toBe(now - 2 * HOUR)
    expect(health.dropped).toEqual({ available: true, value: 0 })
  })

  it('counts the dead letters of the last 60 minutes', async () => {
    mockDropped.mockResolvedValue(4)
    const health = await mockPg.scenario('', () => pipelineHealth(local('2026-11-09T18:00:00')))

    expect(mockDropped).toHaveBeenCalledWith(60 * 60 * SECOND)
    expect(health.dropped).toEqual({ available: true, value: 4 })
    expect(health.lastTransitionAt).toBeNull()
  })

  it('says why dropped records are not available when the topic cannot be read', async () => {
    mockDropped.mockRejectedValue(new DeadLetterReadError('Kafka unreachable'))
    const health = await mockPg.scenario('', () => pipelineHealth(local('2026-11-09T18:00:00')))

    expect(health.dropped).toEqual({ available: false, reason: 'Kafka could not be reached.' })
  })
})

describe('journeys table (HOM-FR-05, HOM-FR-06)', () => {
  it('shows 10 of 12 active journeys by the size of the change, then by name, with owners and messages', async () => {
    const now = local('2026-11-10T09:30:00')
    const range = computeRange('7d', now, zone)
    const inRange = now - HOUR
    const before = range.previous.start + HOUR
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet']
    const setup = [
      usersSql([{ id: 'u-lan', email: 'lan@example.com' }, { id: 'u-minh', email: 'minh@example.com' }]),
      campaignsSql([
        { id: 'CAMP-cart', name: 'Cart abandonment', status: 'active', owner: 'u-lan' },
        { id: 'CAMP-browse', name: 'Browse abandonment', status: 'active', owner: 'u-minh' },
        ...names.map((name) => ({ id: `CAMP-${name}`, name, status: 'active' })),
      ]),
      transitionsSql([
        ...Array.from({ length: 5 }, () => t({ campaign: 'CAMP-cart', node: 's', type: 'setup', branch: 'next', at: inRange })),
        ...Array.from({ length: 3 }, () => t({ campaign: 'CAMP-cart', node: 'e', type: 'engagement', branch: 'next', at: inRange })),
        ...Array.from({ length: 4 }, () => t({ campaign: 'CAMP-browse', node: 's', type: 'setup', branch: 'next', at: before })),
        t({ campaign: 'CAMP-Juliet', node: 's', type: 'setup', branch: 'next', at: inRange }),
      ]),
    ].join('\n')
    const rows = await mockPg.scenario(setup, () => activeJourneys(range, now))

    expect(rows).toHaveLength(10)
    expect(rows.slice(0, 3).map((r) => [r.name, r.change])).toEqual([
      ['Cart abandonment', 5],
      ['Browse abandonment', -4],
      ['Juliet', 1],
    ])
    expect(rows.slice(3).map((r) => r.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'])
    expect(rows[0]).toMatchObject({ ownerId: 'u-lan', ownerEmail: 'lan@example.com', entries: 5, messages: 3 })
    expect(rows[0].last7Days.map((d) => d.value)).toEqual([0, 0, 0, 0, 0, 0, 5])
    expect(rows[3]).toMatchObject({ ownerId: null, ownerEmail: null, entries: 0, messages: 0 })
    expect(rows[3].last7Days.every((d) => d.value === 0)).toBe(true)
  })
})

describe('continue where you left off (HOM-FR-07)', () => {
  it('lists the 5 of the viewer’s 7 journeys with the newest change, of any status', async () => {
    const setup = [
      usersSql([{ id: 'u-lan', email: 'lan@example.com' }, { id: 'u-minh', email: 'minh@example.com' }]),
      campaignsSql([
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `CAMP-${i}`,
          name: `Journey ${i}`,
          status: i % 2 === 0 ? 'active' : 'paused',
          owner: 'u-lan',
          updatedAt: local('2026-11-01T00:00:00') + i * DAY,
        })),
        { id: 'CAMP-other', name: 'Not hers', status: 'active', owner: 'u-minh', updatedAt: local('2026-11-09T00:00:00') },
      ]),
    ].join('\n')
    const rows = await mockPg.scenario(setup, () => recentJourneys('u-lan'))

    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['Journey 6', 'active'],
      ['Journey 5', 'paused'],
      ['Journey 4', 'active'],
      ['Journey 3', 'paused'],
      ['Journey 2', 'active'],
    ])
    expect(rows[0].updatedAt).toBe(local('2026-11-07T00:00:00'))
  })

  it('is empty for a viewer whose owner row was deleted', async () => {
    const rows = await mockPg.scenario(campaignsSql([{ id: 'CAMP-x', name: 'Ownerless', status: 'active' }]), () => recentJourneys('u-gone'))
    expect(rows).toEqual([])
  })
})

describe('no writes (HOM-NFR-02)', () => {
  it('runs only SELECT statements', async () => {
    const now = local('2026-11-09T18:00:00')
    const range = computeRange('30d', now, zone)
    mockDropped.mockResolvedValue(0)
    await mockPg.scenario('', () =>
      Promise.all([kpiCounts(range), engineLag(range), activeJourneys(range, now), recentJourneys('u-lan'), pipelineHealth(now)]),
    )
    expect(mockStatements.length).toBeGreaterThan(0)
    for (const statement of mockStatements) expect(statement.trimStart()).toMatch(/^SELECT\b/)
  })
})
