import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { SqlQuery } from '@/lib/db'

export type Rows = Record<string, unknown>[]

const RUNNER = path.join(__dirname, 'pg-runner.mjs')

/**
 * Applies infra/db/schema.sql and `setup` to a fresh in-memory Postgres, then runs each query and
 * returns its rows. Each call boots Postgres, so batch a scenario's queries into one call.
 */
export function runPostgres(setup: string, queries: readonly SqlQuery[]): Rows[] {
  const output = execFileSync(process.execPath, [RUNNER], {
    input: JSON.stringify({ setup, queries }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(output)
}

export type NodeFixture = {
  id: string
  type: string
  parent?: { id: string; branch: string }
  trigger?: object
  paths?: object
  action?: object
}

export type TransitionFixture = {
  canon: string
  entry: string
  node: string
  branch: string
  at: number
  type: string
  children?: unknown
}

function literal(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

function jsonLiteral(value: unknown): string {
  return value === undefined ? 'NULL' : literal(JSON.stringify(value))
}

/** SQL that inserts a published campaign with its node rows and transitions. */
export function journeySql(campaignId: string, nodes: readonly NodeFixture[], transitions: readonly TransitionFixture[] = []): string {
  const campaign = `INSERT INTO campaigns (id, name, status, root) VALUES (${literal(campaignId)}, ${literal(campaignId)}, 'active', '{}');`
  const nodeRows = nodes.map(
    (node) =>
      `INSERT INTO campaign_nodes (campaign_id, node_id, node_type, parent_node_id, parent_branch, trigger_json, paths_json, action_json, campaign_node_count, graph_version)
VALUES (${literal(campaignId)}, ${literal(node.id)}, ${literal(node.type)}, ${literal(node.parent?.id ?? null)}, ${literal(node.parent?.branch ?? null)},
${jsonLiteral(node.trigger)}, ${jsonLiteral(node.paths)}, ${jsonLiteral(node.action)}, ${nodes.length}, 1);`,
  )
  const transitionRows = transitions.map(
    (t) =>
      `INSERT INTO user_campaign_state_transitions (canon_id, campaign_id, entry_id, node_id, branch, event_timestamp, node_type, children)
VALUES (${literal(t.canon)}, ${literal(campaignId)}, ${literal(t.entry)}, ${literal(t.node)}, ${literal(t.branch)}, ${t.at}, ${literal(t.type)}, ${jsonLiteral(t.children)});`,
  )
  return [campaign, ...nodeRows, ...transitionRows].join('\n')
}
