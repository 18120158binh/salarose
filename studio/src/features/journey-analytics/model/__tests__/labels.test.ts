import { flattenCampaignTree } from '@/entities/journey/model/utils'
import type { CampaignTreeNode } from 'shared/types/campaigns'
import { branchLabel, nodeLabel, referencedNames, removedStepLabel, type NameLookup } from '../labels'
import { parseNodeRow, type JourneyNode } from '../nodes'

const EVENT_NAMES = new Map([
  ['view_product', 'View product'],
  ['add_to_cart', 'Add to cart'],
  ['price_drop', 'Price drop'],
])
const SEGMENT_NAMES = new Map([['SEG-4f1c9a0b2d3e5f67', 'Hanoi cart builders']])

const names: NameLookup = { eventDisplayName: (name) => EVENT_NAMES.get(name), segmentName: (id) => SEGMENT_NAMES.get(id) }

const noNames: NameLookup = { eventDisplayName: () => undefined, segmentName: () => undefined }

function parsed(row: Record<string, unknown>): JourneyNode {
  const node = parseNodeRow({ campaign_id: 'c1', node_id: 'n1', parent_node_id: null, parent_branch: null, ...row })
  if (node === null) throw new Error(`row does not parse: ${JSON.stringify(row)}`)
  return node
}

function label(row: Record<string, unknown>, lookup: NameLookup = names): string {
  return nodeLabel(parsed(row).setting, lookup)
}

describe('nodeLabel on the rows the classic builder publishes', () => {
  const root: CampaignTreeNode = {
    type: 'setup',
    id: 'setup_1',
    label: 'Setup',
    description: '',
    triggerEventName: 'view_product',
    next: {
      type: 'check',
      id: 'check_1',
      label: 'Check',
      eventName: 'purchase',
      next: {
        type: 'YesOrNoPath',
        yes: { type: 'end' },
        no: {
          type: 'watch',
          id: 'watch_1',
          label: 'Watch',
          eventName: 'add_to_cart',
          timeLimitValue: 1,
          timeLimitUnit: 'days',
          next: {
            type: 'SuccessOrTimeoutPath',
            success: { type: 'end' },
            timeout: {
              type: 'engagement',
              id: 'push_1',
              label: 'Push',
              action: { type: 'push', title: 'Still thinking about it?', body: 'Come back', subject: '' },
              next: {
                type: 'watch',
                id: 'delay_1',
                label: 'Delay',
                timeLimitValue: 2,
                timeLimitUnit: 'hours',
                next: {
                  type: 'DelayPath',
                  next: {
                    type: 'segment',
                    id: 'split_1',
                    label: 'Split',
                    next: {
                      type: 'YesPath',
                      yes: { type: 'engagement', id: 'sms_1', label: 'SMS', action: { type: 'sms', title: '', subject: '' }, next: { type: 'end' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }
  const nodes = flattenCampaignTree('c1', root).map((row) => parsed({ ...row }))

  it('labels each node by its type and main setting', () => {
    expect(nodes.map((node) => [node.id, nodeLabel(node.setting, names)])).toEqual([
      ['setup_1', 'Start: View product'],
      ['check_1', 'Check: purchase'],
      ['check_1-yes-end', 'End'],
      ['watch_1', 'Wait for Add to cart, 1 day'],
      ['watch_1-success-end', 'End'],
      ['push_1', 'Push "Still thinking about it?"'],
      ['delay_1', 'Wait 2 hours'],
      ['split_1', 'Condition split'],
      ['sms_1', 'SMS'],
      ['sms_1-next-end', 'End'],
    ])
  })

  it('asks the catalog for the events the labels name', () => {
    expect(referencedNames(nodes)).toEqual({ events: ['add_to_cart', 'purchase', 'view_product'], segments: [] })
  })
})

describe('nodeLabel', () => {
  it('names a segment entry trigger by the segment, or by its id when the segment is gone', () => {
    const row = { node_type: 'setup', trigger_json: JSON.stringify({ kind: 'segment_entry', segment_id: 'SEG-4f1c9a0b2d3e5f67' }) }

    expect(label(row)).toBe('Start: enters Hanoi cart builders')
    expect(label(row, noNames)).toBe('Start: enters SEG-4f1c9a0b2d3e5f67')
    expect(referencedNames([parsed(row)])).toEqual({ events: [], segments: ['SEG-4f1c9a0b2d3e5f67'] })
  })

  it('names a business event trigger by its display name', () => {
    expect(label({ node_type: 'setup', trigger_json: JSON.stringify({ kind: 'business_event', event: 'price_drop' }) })).toBe(
      'Start: Price drop',
    )
  })

  it.each([
    [{ value: 1, unit: 'DAYS' }, 'Wait 1 day'],
    [{ value: 2, unit: 'HOURS' }, 'Wait 2 hours'],
    [{ value: 15, unit: 'MINUTES' }, 'Wait 15 minutes'],
    [{ value: 30, unit: 'SECONDS' }, 'Wait 30 seconds'],
  ])('reads the delay limit %j as %s', (limit, expected) => {
    expect(label({ node_type: 'watch', paths_json: JSON.stringify({ path_type: 'DelayPath', limit }) })).toBe(expected)
  })

  it('shows a channel by its display name, and an unknown channel as saved', () => {
    expect(label({ node_type: 'engagement', action_json: JSON.stringify({ type: 'web-push' }) })).toBe('Web push')
    expect(label({ node_type: 'engagement', action_json: JSON.stringify({ type: 'line', title: 'Hi' }) })).toBe('line "Hi"')
  })

  it('uses the subject when the engagement has no title', () => {
    expect(label({ node_type: 'engagement', action_json: JSON.stringify({ type: 'email', subject: 'Your cart' }) })).toBe(
      'Email "Your cart"',
    )
  })

  it('labels a node whose setting is missing or malformed without its id', () => {
    expect(label({ node_type: 'check', trigger_json: '{"kind": "event", "event": ' })).toBe('Check: an event')
    expect(label({ node_type: 'watch', paths_json: JSON.stringify({ path_type: 'SuccessPath', limit: { value: 1, unit: 'DAYS' } }) })).toBe(
      'Wait for an event, 1 day',
    )
    expect(label({ node_type: 'watch', trigger_json: JSON.stringify({ kind: 'event', event: 'add_to_cart' }), paths_json: null })).toBe(
      'Wait for Add to cart',
    )
    expect(label({ node_type: 'watch', paths_json: JSON.stringify({ path_type: 'DelayPath', limit: { value: 2, unit: 'WEEKS' } }) })).toBe('Wait')
    expect(label({ node_type: 'setup', trigger_json: JSON.stringify({ kind: 'audience' }) })).toBe('Start')
    expect(label({ node_type: 'engagement', action_json: null })).toBe('Engagement')
  })
})

describe('removedStepLabel', () => {
  it('names the node type of a removed step', () => {
    expect(removedStepLabel('end')).toBe('Removed step (end)')
  })
})

describe('branchLabel', () => {
  it.each([
    ['next', 'Next'],
    ['yes', 'Yes'],
    ['no', 'No'],
    ['success', 'Success'],
    ['timeout', 'Timeout'],
    ['vip', 'vip'],
    ['constructor', 'constructor'],
  ])('shows %p as %p', (branch, label) => {
    expect(branchLabel(branch)).toBe(label)
  })
})
