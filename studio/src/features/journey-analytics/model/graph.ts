import type { NodeAnalytics } from './queries'

export type GraphNode = { readonly step: NodeAnalytics; readonly children: readonly GraphNode[] }

/**
 * The steps as trees for the graph. The steps come in tree order, so each parent comes before its
 * children and the children come in branch order. A step is a child only when its parent sits one
 * level above it, so an orphan or a cycle that tree order placed at depth 0 starts its own tree.
 */
export function graphRoots(steps: readonly NodeAnalytics[]): GraphNode[] {
  const built = new Map<string, { step: NodeAnalytics; children: GraphNode[] }>()
  for (const step of steps) built.set(step.node.id, { step, children: [] })

  const roots: GraphNode[] = []
  for (const step of steps) {
    const node = built.get(step.node.id)
    if (node === undefined) continue
    const parent = step.node.parentId === null ? undefined : built.get(step.node.parentId)
    if (parent !== undefined && parent.step.depth === step.depth - 1) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
