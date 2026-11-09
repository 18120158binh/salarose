/** @jest-environment node */

// The journey analytics loaders check the session before they touch the database, so a page that
// forgets its own check still reads nothing for a visitor who is not signed in.
const mockRequireViewer = jest.fn()
const mockReadOnly = jest.fn()

// A relative path, because the jest moduleNameMapper sends `@/widgets/...` to the studio root, not
// to src/. The import in server.ts resolves to this same file.
jest.mock('../../../../widgets/v2-shell/model/viewer', () => ({ requireViewer: () => mockRequireViewer() }))
jest.mock('@/lib/db', () => ({ readOnly: (...args: unknown[]) => mockReadOnly(...args) }))

import type { SqlQuery } from '@/lib/db'
import { eventTimeCounts } from '@/features/home-overview/model/queries'
import { computeRange, UTC, type TimeZone } from '@/shared/lib/time-range'
import { publishedCampaignsQuery } from '../journeyList'
import { loadJourneyAnalytics, loadJourneySummary, loadPeopleWaiting, loadPublishedJourneys, loadWaitingSteps } from '../server'

const loaders: [string, () => Promise<unknown>][] = [
  ['loadJourneyAnalytics', () => loadJourneyAnalytics('cmp_1', null)],
  ['loadJourneySummary', () => loadJourneySummary('cmp_1')],
  ['loadWaitingSteps', () => loadWaitingSteps('canon_1')],
  ['loadPeopleWaiting', () => loadPeopleWaiting('cmp_1')],
]

beforeEach(() => {
  mockRequireViewer.mockReset()
  mockReadOnly.mockReset()
})

describe.each(loaders)('%s', (_name, load) => {
  it('rejects with the sign-in redirect and reads nothing without a session', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })
    mockRequireViewer.mockRejectedValue(redirect)

    await expect(load()).rejects.toBe(redirect)
    expect(mockReadOnly).not.toHaveBeenCalled()
  })

  it('reads through the read-only helper with the statement timeout for a signed-in viewer', async () => {
    mockRequireViewer.mockResolvedValue({ userId: 'user_lan', email: 'lan@example.com', role: 'editor' })
    mockReadOnly.mockResolvedValue('rows from readOnly')

    await expect(load()).resolves.toBe('rows from readOnly')
    expect(mockReadOnly).toHaveBeenCalledWith(5000, expect.any(Function))
  })
})

describe('loadPublishedJourneys', () => {
  it('rejects with the sign-in redirect and reads nothing without a session', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' })
    mockRequireViewer.mockRejectedValue(redirect)

    await expect(loadPublishedJourneys(UTC)).rejects.toBe(redirect)
    expect(mockReadOnly).not.toHaveBeenCalled()
  })

  it('reads through the read-only helper with the statement timeout, and returns the instant it counted to', async () => {
    mockRequireViewer.mockResolvedValue({ userId: 'user_lan', email: 'lan@example.com', role: 'editor' })
    mockReadOnly.mockResolvedValue([])
    const before = Date.now()

    const { now, journeys } = await loadPublishedJourneys(UTC)

    expect(journeys).toEqual([])
    expect(now).toBeGreaterThanOrEqual(before)
    expect(mockReadOnly).toHaveBeenCalledWith(5000, expect.any(Function))
  })

  it('counts the setup transitions of each journey over Last 7 days in the zone of the viewer', async () => {
    const zone = 'Asia/Ho_Chi_Minh' as TimeZone
    const sent: SqlQuery[] = []
    const answers: Record<string, unknown>[][] = [
      [{ id: 'CAMP-a', name: 'Welcome series', status: 'active', owner_id: 'user_lan', owner_email: 'lan@example.com', updated_at: null }],
      [
        { bucket: 0, campaign_id: 'CAMP-a', branch: 'next', n: 3 },
        { bucket: 0, campaign_id: 'CAMP-a', branch: 'other', n: 2 },
      ],
    ]
    mockRequireViewer.mockResolvedValue({ userId: 'user_lan', email: 'lan@example.com', role: 'editor' })
    mockReadOnly.mockImplementation(async (_timeout: number, work: (run: (query: SqlQuery) => Promise<unknown[]>) => unknown) =>
      work(async (query) => {
        sent.push(query)
        return answers[sent.length - 1]
      }),
    )

    const { now, journeys } = await loadPublishedJourneys(zone)

    expect(sent).toEqual([publishedCampaignsQuery(), eventTimeCounts('setup', [computeRange('7d', now, zone).current], ['CAMP-a'])])
    expect(computeRange('7d', now, zone).current).not.toEqual(computeRange('7d', now, UTC).current)
    expect(journeys).toEqual([expect.objectContaining({ id: 'CAMP-a', entries: 5 })])
  })
})
