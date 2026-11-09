import { withStage } from '@/widgets/v2-shell/model/__fixtures__/stage'
import { droppedLink, lagKpi, parseCampaignRows, watchKpi, type KpiCounts, type Tally } from '../home'

const tally = (current: number, previous: number): Tally => ({ current, previous, days: [] })

const counts = (success: [number, number], timeout: [number, number]): KpiCounts => ({
  entries: tally(0, 0),
  messages: tally(0, 0),
  watchSuccess: tally(...success),
  watchTimeout: tally(...timeout),
})

describe('changes the shell leaves undefined (SHL-FR-16)', () => {
  it('shows no watch success and no change when no watch finished', () => {
    const view = watchKpi(counts([0, 3], [0, 1]))
    expect(view.value).toEqual({ available: true, value: 'No watches finished' })
    expect(view.change).toBeNull()
    expect(view.detail).toBeNull()
  })

  it('shows no change for watch success against a previous period with no finished watch', () => {
    const view = watchKpi(counts([41, 0], [59, 0]))
    expect(view.value).toEqual({ available: true, value: '41%' })
    expect(view.change).toBeNull()
  })

  it('reads 41% against 44% as -3 pts in the bad direction', () => {
    expect(watchKpi(counts([41, 44], [59, 56])).change).toEqual({ label: '-3 pts', direction: 'down', tone: 'bad' })
  })

  it('shows no lag change against a previous period with no activity or 0 s', () => {
    expect(lagKpi({ current: 2_000, previous: null, days: [] }).change).toBeNull()
    expect(lagKpi({ current: 2_000, previous: 0, days: [] }).change).toBeNull()
  })

  it('reads a lag of 90 s against 60 s as +50% in the bad direction', () => {
    expect(lagKpi({ current: 90_000, previous: 60_000, days: [] }).change).toEqual({ label: '+50%', direction: 'up', tone: 'bad' })
  })
})

// Home links to the first data page that has shipped, or to the classic page that does its job, or
// to nothing where the viewer has no such page (SHL-FR-01, HOM-FR-08).
describe('droppedLink', () => {
  it('sends an admin to the classic event catalog while neither data page has shipped', async () => {
    await withStage(['dead-letters', 'events'], "reserved", () => {
      expect(droppedLink({ role: 'admin', preview: false })).toEqual({ href: '/admin/events', text: 'Open events' })
    })
  })

  it('sends an admin and an editor to the event catalog view while the dead-letter browser has not shipped', async () => {
    await withStage(['dead-letters'], "reserved", () => {
      expect(droppedLink({ role: 'admin', preview: false })).toEqual({ href: '/v2/data/events', text: 'Open events' })
      expect(droppedLink({ role: 'editor', preview: false })).toEqual({ href: '/v2/data/events', text: 'Open events' })
    })
  })

  it('sends an admin to the dead-letter browser once it ships, and an editor still to the event catalog view', async () => {
    await withStage(['dead-letters'], "shipped", () => {
      expect(droppedLink({ role: 'admin', preview: false })).toEqual({ href: '/v2/data/dead-letters', text: 'Open dead letters' })
      expect(droppedLink({ role: 'editor', preview: false })).toEqual({ href: '/v2/data/events', text: 'Open events' })
    })
  })
})

describe('parseCampaignRows', () => {
  it('keeps the owner id, and null for a journey without an owner', () => {
    expect(
      parseCampaignRows([
        { id: 'CAMP-a', name: 'A', owner_id: 'u-lan', owner_email: 'lan@example.com' },
        { id: 'CAMP-b', name: 'B', owner_id: null, owner_email: null },
      ]),
    ).toEqual([
      { id: 'CAMP-a', name: 'A', ownerId: 'u-lan', ownerEmail: 'lan@example.com' },
      { id: 'CAMP-b', name: 'B', ownerId: null, ownerEmail: null },
    ])
  })
})
