import { nameLookup, assembleNodeAnalytics } from '../queries'
import { parseNodeRow, type JourneyNode } from '../nodes'

function row(id: string, type: string, parent: [string, string] | null, paths?: object): Record<string, unknown> {
  return {
    campaign_id: 'c1',
    node_id: id,
    node_type: type,
    parent_node_id: parent?.[0] ?? null,
    parent_branch: parent?.[1] ?? null,
    trigger_json: null,
    paths_json: paths === undefined ? null : JSON.stringify(paths),
    action_json: null,
  }
}

function nodes(rows: Record<string, unknown>[]): JourneyNode[] {
  return rows.flatMap((r) => parseNodeRow(r) ?? [])
}

describe('parseNodeRow', () => {
  it('leaves out a row with an unknown node_type or a non-text id, and says which', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const kept = nodes([row('s', 'setup', null), row('x', 'goal', ['s', 'next']), { ...row('y', 'end', null), node_id: 7 }])

    expect(kept.map((node) => node.id)).toEqual(['s'])
    expect(warn.mock.calls).toEqual([
      ['Leaving node x of campaign c1 out of journey analytics: its id or node_type does not parse.'],
      ['Leaving node 7 of campaign c1 out of journey analytics: its id or node_type does not parse.'],
    ])
    warn.mockRestore()
  })
})

describe('tree order', () => {
  it('walks depth first from the setup node, branches in branch table order, orphans last', () => {
    const journey = nodes([
      row('zz', 'end', ['gone', 'next']),
      row('p-b', 'engagement', ['w', 'timeout']),
      row('x', 'end', ['c', 'legacy']),
      row('w-success-end', 'end', ['w', 'success']),
      row('m-regular-end', 'end', ['m', 'regular']),
      row('p-a-next-end', 'end', ['p-a', 'next']),
      row('w', 'watch', ['c', 'no'], { path_type: 'SuccessOrTimeoutPath', limit: { value: 1, unit: 'DAYS' } }),
      row('m-vip-end', 'end', ['m', 'vip']),
      row('aa-orphan', 'end', null),
      row('p-a', 'engagement', ['w', 'timeout']),
      row('m', 'check', ['c', 'yes'], { path_type: 'MultiBranchPath', branches: [{ key: 'vip' }, { key: 'regular' }] }),
      row('c', 'check', ['s', 'next']),
      row('s', 'setup', null),
    ])

    const placed = assembleNodeAnalytics(journey, [], nameLookup([])).map(({ node, depth }) => [node.id, depth])

    expect(placed).toEqual([
      ['s', 0],
      ['c', 1],
      ['m', 2],
      ['m-vip-end', 3],
      ['m-regular-end', 3],
      ['w', 2],
      ['w-success-end', 3],
      ['p-a', 3],
      ['p-a-next-end', 4],
      ['p-b', 3],
      ['x', 2],
      ['aa-orphan', 0],
      ['zz', 0],
    ])
  })
})
