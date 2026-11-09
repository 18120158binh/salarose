import { LIMIT_UNITS, type LimitUnit, type NodeType } from 'shared/types/campaigns'

export type Limit = { readonly value: number; readonly unit: LimitUnit }

export type SetupTrigger =
  | { readonly kind: 'event'; readonly event: string }
  | { readonly kind: 'segment_entry'; readonly segmentId: string }
  | { readonly kind: 'business_event'; readonly event: string }

/** What a node's label reads from its `campaign_nodes` row. A part that does not parse is null. */
export type NodeSetting =
  | { readonly type: 'setup'; readonly trigger: SetupTrigger | null }
  | { readonly type: 'check'; readonly event: string | null }
  | { readonly type: 'watch'; readonly event: string | null; readonly delay: boolean; readonly limit: Limit | null }
  | { readonly type: 'segment' }
  | { readonly type: 'engagement'; readonly channel: string | null; readonly headline: string | null }
  | { readonly type: 'end' }

export type JourneyNode = {
  readonly id: string
  readonly parentId: string | null
  readonly parentBranch: string | null
  /** A multi-branch check's branch keys in saved order. Empty for every other node. */
  readonly branchOrder: readonly string[]
  readonly setting: NodeSetting
}

type JsonObject = { readonly [key: string]: unknown }

type SavedJson = { readonly trigger: JsonObject | null; readonly paths: JsonObject | null; readonly action: JsonObject | null }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJsonObject(column: unknown): JsonObject | null {
  if (typeof column !== 'string') return null
  try {
    const value: unknown = JSON.parse(column)
    return isJsonObject(value) ? value : null
  } catch {
    return null
  }
}

function text(json: JsonObject | null, key: string): string | null {
  const value = json?.[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function isLimitUnit(value: unknown): value is LimitUnit {
  return typeof value === 'string' && (LIMIT_UNITS as readonly string[]).includes(value)
}

function limit(paths: JsonObject | null): Limit | null {
  const saved = paths?.limit
  if (!isJsonObject(saved)) return null
  const { value, unit } = saved
  return typeof value === 'number' && Number.isFinite(value) && isLimitUnit(unit) ? { value, unit } : null
}

function setupTrigger(trigger: JsonObject | null): SetupTrigger | null {
  const event = text(trigger, 'event')
  const segmentId = text(trigger, 'segment_id')
  switch (trigger?.kind) {
    case 'event':
      return event === null ? null : { kind: 'event', event }
    case 'business_event':
      return event === null ? null : { kind: 'business_event', event }
    case 'segment_entry':
      return segmentId === null ? null : { kind: 'segment_entry', segmentId }
    default:
      return null
  }
}

function multiBranchKeys(paths: JsonObject | null): string[] {
  if (paths?.path_type !== 'MultiBranchPath' || !Array.isArray(paths.branches)) return []
  return paths.branches.flatMap((branch: unknown) =>
    isJsonObject(branch) && typeof branch.key === 'string' ? [branch.key] : [],
  )
}

const SETTINGS: { readonly [T in NodeType]: (saved: SavedJson) => Extract<NodeSetting, { type: T }> } = {
  setup: ({ trigger }) => ({ type: 'setup', trigger: setupTrigger(trigger) }),
  check: ({ trigger }) => ({ type: 'check', event: text(trigger, 'event') }),
  watch: ({ trigger, paths }) => ({
    type: 'watch',
    event: text(trigger, 'event'),
    delay: paths?.path_type === 'DelayPath',
    limit: limit(paths),
  }),
  segment: () => ({ type: 'segment' }),
  engagement: ({ action }) => ({
    type: 'engagement',
    channel: text(action, 'type'),
    headline: text(action, 'title') ?? text(action, 'subject'),
  }),
  end: () => ({ type: 'end' }),
}

function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && Object.hasOwn(SETTINGS, value)
}

/**
 * Parses one `campaign_nodes` row. A row without a text id or with an unknown `node_type` is left
 * out. Malformed JSON in a setting column never drops the node: counting does not read the
 * setting, so only the label loses that part.
 */
export function parseNodeRow(row: Record<string, unknown>): JourneyNode | null {
  const { campaign_id, node_id, node_type, parent_node_id, parent_branch } = row
  if (typeof node_id !== 'string' || !isNodeType(node_type)) {
    console.warn(
      `Leaving node ${String(node_id)} of campaign ${String(campaign_id)} out of journey analytics: its id or node_type does not parse.`,
    )
    return null
  }
  const saved: SavedJson = {
    trigger: parseJsonObject(row.trigger_json),
    paths: parseJsonObject(row.paths_json),
    action: parseJsonObject(row.action_json),
  }
  return {
    id: node_id,
    parentId: typeof parent_node_id === 'string' ? parent_node_id : null,
    parentBranch: typeof parent_branch === 'string' ? parent_branch : null,
    branchOrder: multiBranchKeys(saved.paths),
    setting: SETTINGS[node_type](saved),
  }
}

/** Code unit order, as Java's `String.compareTo` sorts children in the engine's graph. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Orders a node's branches as the journey builder's branch table does: `next`, `yes`, `no`, a
 * multi-branch check's keys in saved order, `success`, `timeout`, then any other branch by name.
 */
export function sortBranches(branches: Iterable<string>, branchOrder: readonly string[]): string[] {
  const sequence = ['next', 'yes', 'no', ...branchOrder, 'success', 'timeout']
  const rank = (branch: string) => {
    const index = sequence.indexOf(branch)
    return index === -1 ? sequence.length : index
  }
  return [...new Set(branches)].sort((a, b) => rank(a) - rank(b) || byCodeUnits(a, b))
}

export type PlacedNode = { readonly node: JourneyNode; readonly depth: number }

/**
 * Depth first from the setup node, children grouped by branch in branch table order and by id
 * within a branch. Nodes the walk does not reach, such as orphans, follow by id at depth 0.
 */
export function treeOrder(nodes: readonly JourneyNode[]): PlacedNode[] {
  const byId = [...nodes].sort((a, b) => byCodeUnits(a.id, b.id))
  const children = new Map<string, JourneyNode[]>()
  for (const node of byId) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }

  const placed: PlacedNode[] = []
  const seen = new Set<string>()
  const visit = (node: JourneyNode, depth: number) => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    placed.push({ node, depth })
    const below = children.get(node.id) ?? []
    for (const branch of sortBranches(below.map(branchOf), node.branchOrder)) {
      for (const child of below) if (branchOf(child) === branch) visit(child, depth + 1)
    }
  }
  for (const node of byId) if (node.setting.type === 'setup') visit(node, 0)
  for (const node of byId) if (!seen.has(node.id)) placed.push({ node, depth: 0 })
  return placed
}

function branchOf(node: JourneyNode): string {
  return node.parentBranch ?? ''
}
