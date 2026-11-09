import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { SqlQuery } from '@/lib/db'

export type Rows = Record<string, unknown>[]

type Pending = { resolve: (rows: Rows) => void; reject: (error: Error) => void }

/**
 * One in-memory Postgres for a test file, with infra/db/schema.sql applied. `scenario` runs a
 * test's fixture SQL and queries in a transaction that it rolls back, so tests do not share rows.
 */
export class TestPostgres {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  readonly ready: Promise<void>

  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, 'pg-runner.mjs')])
    let markReady: () => void = () => {}
    this.ready = new Promise((resolve) => (markReady = resolve))
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.ready) return markReady()
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) waiter?.reject(new Error(message.error))
      else waiter?.resolve(message.rows)
    })
  }

  private send(text: string, values?: unknown[]): Promise<Rows> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ id, text, values })}\n`)
    })
  }

  query(query: SqlQuery): Promise<Rows> {
    return this.send(query.text, query.values)
  }

  async scenario<T>(setup: string, work: () => Promise<T>): Promise<T> {
    await this.ready
    await this.send(`BEGIN; ${setup}`)
    try {
      return await work()
    } finally {
      await this.send('ROLLBACK')
    }
  }

  close(): void {
    this.child.stdin.end()
  }
}

function literal(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`
}

export type TransitionFixture = {
  campaign?: string
  canon: string
  entry?: string
  node: string
  type: string
  branch: string
  // Event time and write time, in epoch milliseconds.
  at: number
  written?: number
}

export function transitionsSql(transitions: readonly TransitionFixture[]): string {
  return transitions
    .map(
      (t) => `INSERT INTO user_campaign_state_transitions (canon_id, campaign_id, entry_id, node_id, branch, event_timestamp, node_type, transitioned_at)
VALUES (${literal(t.canon)}, ${literal(t.campaign ?? 'CAMP-a')}, ${literal(t.entry ?? 'first')}, ${literal(t.node)}, ${literal(t.branch)}, ${t.at}, ${literal(t.type)}, to_timestamp(${t.written ?? t.at} / 1000.0));`,
    )
    .join('\n')
}

export type CampaignFixture = {
  id: string
  name: string
  status: string
  owner?: string
  updatedAt?: number
}

export type UserFixture = { id: string; email: string; role?: string }

export function usersSql(users: readonly UserFixture[]): string {
  return users
    .map(
      (u) => `INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES (${literal(u.id)}, ${literal(u.email)}, ${literal(u.role ?? 'editor')}, 'https://idp.test', ${literal(u.id)});`,
    )
    .join('\n')
}

export function campaignsSql(campaigns: readonly CampaignFixture[]): string {
  return campaigns
    .map(
      (c) => `INSERT INTO campaigns (id, name, status, root, created_user, updated_at) VALUES (${literal(c.id)}, ${literal(c.name)}, ${literal(c.status)}, '{"type":"setup"}', ${literal(c.owner ?? null)}, to_timestamp(${c.updatedAt ?? 0} / 1000.0));`,
    )
    .join('\n')
}
