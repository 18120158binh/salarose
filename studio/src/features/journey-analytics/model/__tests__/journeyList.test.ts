/** @jest-environment node */

import { eventTimeCounts } from '@/features/home-overview/model/queries'
import { parseCountRows } from '@/features/home-overview/model/home'
import { computeRange, UTC } from '@/shared/lib/time-range'
import {
  DEFAULT_QUERY,
  draftRows,
  parseJourneySummary,
  publishedCampaignQuery,
  publishedCampaignsQuery,
  publishedJourneys,
  rowActions,
  serverDraftRows,
  statusCounts,
  visibleJourneys,
  type DraftJourney,
  type JourneyRow,
  type ListQuery,
  type PublishedJourney,
} from '../journeyList'
import { runPostgres } from '../testing/pg'
import type { Viewer } from '@/widgets/v2-shell/model/routes'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 9, 10)
const POSTGRES_TIMEOUT_MS = 60_000

const published = (id: string, fields: Partial<PublishedJourney> = {}): PublishedJourney => ({
  kind: 'published',
  id,
  name: id,
  status: 'active',
  ownerId: 'u-lan',
  ownerEmail: 'lan@example.com',
  entries: 0,
  updatedAt: NOW - DAY,
  ...fields,
})

const draft = (id: string, fields: Partial<DraftJourney> = {}): DraftJourney => ({ kind: 'draft', source: 'server', id, name: id, updatedAt: NOW, note: null, ...fields })

const ids = (rows: readonly JourneyRow[]) => rows.map((row) => row.id)
const LAN: Viewer = { userId: 'u-lan', role: 'editor' }
const query = (change: Partial<ListQuery>): ListQuery => ({ ...DEFAULT_QUERY, ...change })

describe('the published journeys read (JBD-FR-18)', () => {
  const lastWeek = computeRange('7d', NOW, UTC).current
  const setup = `
INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES ('u-lan', 'lan@example.com', 'editor', 'i', 'lan');
INSERT INTO campaigns (id, name, status, root, created_user, updated_at) VALUES
  ('CAMP-cart', 'Cart abandonment', 'active', '{}', 'u-lan', '2026-11-08T09:00:00Z'),
  ('CAMP-welcome', 'Welcome series', 'paused', '{}', NULL, '2026-11-01T09:00:00Z'),
  ('CAMP-old', 'Old journey', 'deleted', '{}', 'u-lan', '2026-10-01T09:00:00Z');
INSERT INTO user_campaign_state_transitions (canon_id, campaign_id, entry_id, node_id, branch, event_timestamp, node_type) VALUES
  ('c1', 'CAMP-cart', 'e1', 'S', 'next', ${lastWeek.start}, 'setup'),
  ('c2', 'CAMP-cart', 'e2', 'S', 'next', ${lastWeek.end - 1}, 'setup'),
  ('c3', 'CAMP-cart', 'e3', 'S', 'next', ${lastWeek.start - 1}, 'setup'),
  ('c4', 'CAMP-cart', 'e4', 'S', 'next', ${lastWeek.end}, 'setup'),
  ('c1', 'CAMP-cart', 'e1', 'W', 'success', ${lastWeek.start + DAY}, 'watch');`

  it(
    'lists the active and paused campaigns with their owner and their setup transitions in the last 7 days',
    () => {
      const [campaigns, counts] = runPostgres(setup, [
        publishedCampaignsQuery(),
        eventTimeCounts('setup', [lastWeek], ['CAMP-cart', 'CAMP-welcome', 'CAMP-old']),
      ])

      const rows = publishedJourneys(campaigns, parseCountRows(counts)).sort((a, b) => a.id.localeCompare(b.id))

      expect(rows).toEqual([
        {
          kind: 'published',
          id: 'CAMP-cart',
          name: 'Cart abandonment',
          status: 'active',
          ownerId: 'u-lan',
          ownerEmail: 'lan@example.com',
          entries: 2,
          updatedAt: Date.parse('2026-11-08T09:00:00Z'),
        },
        {
          kind: 'published',
          id: 'CAMP-welcome',
          name: 'Welcome series',
          status: 'paused',
          ownerId: null,
          ownerEmail: null,
          entries: 0,
          updatedAt: Date.parse('2026-11-01T09:00:00Z'),
        },
      ])
    },
    POSTGRES_TIMEOUT_MS,
  )

  it(
    'reads one published campaign, and nothing for a campaign that is not published or does not exist (JBD-FR-19)',
    () => {
      const [cart, old, missing] = runPostgres(setup, [
        publishedCampaignQuery('CAMP-cart'),
        publishedCampaignQuery('CAMP-old'),
        publishedCampaignQuery("'; DROP TABLE campaigns; --"),
      ])

      expect(cart.map(parseJourneySummary)).toEqual([
        {
          id: 'CAMP-cart',
          name: 'Cart abandonment',
          status: 'active',
          ownerId: 'u-lan',
          ownerEmail: 'lan@example.com',
          updatedAt: Date.parse('2026-11-08T09:00:00Z'),
        },
      ])
      expect(old).toEqual([])
      expect(missing).toEqual([])
    },
    POSTGRES_TIMEOUT_MS,
  )
})

describe('publishedJourneys', () => {
  it('sums a journey setup counts over every branch, and drops a row it cannot read', () => {
    const rows = publishedJourneys(
      [
        { id: 'CAMP-a', name: 'A', status: 'active', owner_id: null, owner_email: null, updated_at: null },
        { id: 'CAMP-b', name: 'B', status: 'draft', owner_id: null, owner_email: null, updated_at: null },
        { id: 7, name: 'C', status: 'active' },
      ],
      [
        { bucket: 1, campaignId: 'CAMP-a', branch: 'next', n: 3 },
        { bucket: 1, campaignId: 'CAMP-a', branch: 'other', n: 2 },
      ],
    )

    expect(rows).toEqual([published('CAMP-a', { name: 'A', ownerId: null, ownerEmail: null, entries: 5, updatedAt: null })])
  })
})

describe('draftRows', () => {
  it('reads each draft and leaves out a draft whose id is published already', () => {
    const drafts = [
      { id: 'CAMP-new', name: 'New idea', updated_at: '2026-11-09T08:00:00Z' },
      { id: 'CAMP-cart', name: 'Cart abandonment', updated_at: '2026-11-09T08:00:00Z' },
    ]

    expect(draftRows(drafts, [published('CAMP-cart')])).toEqual([
      { kind: 'draft', source: 'browser', id: 'CAMP-new', name: 'New idea', updatedAt: Date.parse('2026-11-09T08:00:00Z'), note: null },
    ])
  })
})

describe('visibleJourneys (JBD-FR-18)', () => {
  const mine = published('CAMP-mine', { name: 'Welcome series', ownerId: 'u-lan' })
  const theirs = published('CAMP-theirs', { name: 'Cart abandonment', ownerId: 'u-minh', status: 'paused' })
  const orphan = published('CAMP-orphan', { name: 'Browse abandonment', ownerId: null })
  const sketch = draft('CAMP-draft', { name: 'Winback sketch' })
  const rows = [mine, theirs, orphan, sketch]

  it('shows the viewer journeys and drafts under Mine, the default', () => {
    expect(ids(visibleJourneys(rows, DEFAULT_QUERY, LAN)).sort()).toEqual(['CAMP-draft', 'CAMP-mine'])
  })

  it('also shows an admin the journeys whose owner was deleted under Mine, as the classic list does', () => {
    const admin: Viewer = { userId: 'u-lan', role: 'admin' }

    expect(ids(visibleJourneys(rows, DEFAULT_QUERY, admin)).sort()).toEqual(['CAMP-draft', 'CAMP-mine', 'CAMP-orphan'])
  })

  it('shows every published journey under All, and no draft', () => {
    expect(ids(visibleJourneys(rows, query({ owner: 'all' }), LAN)).sort()).toEqual(['CAMP-mine', 'CAMP-orphan', 'CAMP-theirs'])
  })

  it('narrows by status', () => {
    expect(ids(visibleJourneys(rows, query({ owner: 'all', status: 'paused' }), LAN))).toEqual(['CAMP-theirs'])
    expect(ids(visibleJourneys(rows, query({ status: 'draft' }), LAN))).toEqual(['CAMP-draft'])
  })

  it('matches the search anywhere in the name, ignoring case', () => {
    expect(ids(visibleJourneys(rows, query({ owner: 'all', search: '  ABANDON ' }), LAN)).sort()).toEqual([
      'CAMP-orphan',
      'CAMP-theirs',
    ])
  })

  it('sorts by last change, newest first, by default, with a row of unknown time last', () => {
    const rowsByTime = [
      published('CAMP-1', { updatedAt: NOW - 3 * DAY }),
      published('CAMP-2', { updatedAt: null }),
      published('CAMP-3', { updatedAt: NOW - DAY }),
    ]
    expect(ids(visibleJourneys(rowsByTime, DEFAULT_QUERY, LAN))).toEqual(['CAMP-3', 'CAMP-1', 'CAMP-2'])
  })

  it('sorts by name, ignoring case', () => {
    const named = [published('CAMP-1', { name: 'beta' }), published('CAMP-2', { name: 'Alpha' }), published('CAMP-3', { name: 'gamma' })]
    expect(ids(visibleJourneys(named, query({ sort: 'name' }), LAN))).toEqual(['CAMP-2', 'CAMP-1', 'CAMP-3'])
  })

  it('sorts by entries, most first, with drafts after every published journey', () => {
    const counted = [published('CAMP-1', { entries: 4 }), draft('CAMP-2'), published('CAMP-3', { entries: 0 }), published('CAMP-4', { entries: 90 })]
    expect(ids(visibleJourneys(counted, query({ sort: 'entries' }), LAN))).toEqual(['CAMP-4', 'CAMP-1', 'CAMP-3', 'CAMP-2'])
  })
})

describe('serverDraftRows', () => {
  const templateName = (key: string) => (key === 'cart' ? 'Abandoned cart' : undefined)
  const row = (origin: string) =>
    serverDraftRows([{ id: 'CAMP-d', name: 'D', origin, updatedAt: '2026-11-09T08:00:00.000Z' }], [published('CAMP-w', { name: 'Welcome series' })], templateName)[0]

  it('says where each draft came from', () => {
    expect(row('blank')).toEqual({ kind: 'draft', source: 'server', id: 'CAMP-d', name: 'D', updatedAt: Date.parse('2026-11-09T08:00:00Z'), note: 'Started blank' })
    expect(row('template:cart').note).toBe('From template Abandoned cart')
    expect(row('duplicate:CAMP-w').note).toBe('Duplicated from Welcome series')
    expect(row('duplicate:CAMP-gone').note).toBe('Duplicated from a journey')
    expect(row('ai').note).toBe('Described with AI')
    expect(row('browser').note).toBe('Moved from this browser')
  })
})

describe('statusCounts', () => {
  it('counts each status under the owner filter and the search', () => {
    const rows = [published('a'), published('b', { status: 'paused' }), published('c', { ownerId: 'u-minh' }), draft('d')]

    expect(statusCounts(rows, DEFAULT_QUERY, LAN)).toEqual({ any: 3, draft: 1, active: 1, paused: 1 })
    expect(statusCounts(rows, { ...DEFAULT_QUERY, owner: 'all' }, LAN)).toEqual({ any: 3, draft: 0, active: 2, paused: 1 })
  })
})

describe('rowActions (CMP-FR-07 to CMP-FR-09)', () => {
  const MINH: Viewer = { userId: 'u-minh', role: 'admin' }
  const HOA: Viewer = { userId: 'u-hoa', role: 'editor' }

  it('offers the owner Open, Duplicate, Pause or Resume, and Delete', () => {
    expect(rowActions(published('a'), LAN, true)).toEqual(['open', 'duplicate', 'pause', 'delete'])
    expect(rowActions(published('a', { status: 'paused' }), LAN, true)).toEqual(['open', 'duplicate', 'resume', 'delete'])
  })

  it('offers a colleague Open and Duplicate only, and an admin everything, also on a journey with no owner', () => {
    expect(rowActions(published('a'), HOA, true)).toEqual(['open', 'duplicate'])
    expect(rowActions(published('a', { ownerId: null }), MINH, true)).toEqual(['open', 'duplicate', 'pause', 'delete'])
  })

  it('leaves out Duplicate for a viewer the v2 builder does not let through', () => {
    expect(rowActions(published('a'), LAN, false)).toEqual(['open', 'pause', 'delete'])
  })

  it('offers Open and Delete on a server draft, and only Open on a browser draft', () => {
    expect(rowActions(draft('d'), LAN, true)).toEqual(['open', 'delete'])
    expect(rowActions(draft('d', { source: 'browser' }), LAN, true)).toEqual(['open'])
  })
})
