import { graphRoots, type GraphNode } from '../graph'
import type { JourneyNode } from '../nodes'
import type { NodeAnalytics } from '../queries'

function step(id: string, depth: number, parent: [string, string] | null = null): NodeAnalytics {
  const node: JourneyNode = {
    id,
    parentId: parent?.[0] ?? null,
    parentBranch: parent?.[1] ?? null,
    branchOrder: [],
    setting: depth === 0 ? { type: 'setup', trigger: null } : { type: 'end' },
  }
  return { node, label: id, depth, entered: 0, completed: 0, waiting: 0, split: [] }
}

type Shape = { id: string; children: Shape[] }
const shape = (nodes: readonly GraphNode[]): Shape[] => nodes.map((node) => ({ id: node.step.node.id, children: shape(node.children) }))

describe('graphRoots', () => {
  it('nests each step under its parent in the order of the table', () => {
    const steps = [step('S', 0), step('C', 1, ['S', 'next']), step('Y', 2, ['C', 'yes']), step('N', 2, ['C', 'no'])]

    expect(shape(graphRoots(steps))).toEqual([
      { id: 'S', children: [{ id: 'C', children: [{ id: 'Y', children: [] }, { id: 'N', children: [] }] }] },
    ])
  })

  it('starts a tree at a step whose parent is not a current node, and at a cycle tree order put at depth 0', () => {
    const steps = [step('S', 0), step('O', 0, ['gone', 'yes']), step('A', 0, ['B', 'next']), step('B', 0, ['A', 'next'])]

    expect(shape(graphRoots(steps)).map((root) => root.id)).toEqual(['S', 'O', 'A', 'B'])
  })
})
