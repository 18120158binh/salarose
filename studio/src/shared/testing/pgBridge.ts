import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'

type Reply = { id: number; rows?: Record<string, unknown>[]; rowCount?: number; error?: { message: string; code?: string; constraint?: string } }
export type QueryResult = { rows: Record<string, unknown>[]; rowCount: number }

/**
 * A stand-in for the pg module whose Pool sends every statement to one PGlite process with the
 * schema applied. PGlite has one connection, so the tests must not run two transactions at once.
 * `fail` makes the next matching statement throw, as a database failure mid-transaction would.
 */
export class PgBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, (reply: Reply) => void>()
  private failure: { when: RegExp; error: Record<string, unknown> } | null = null

  /** Throws on the next statement that matches, with the fields a pg error carries, such as `code`. */
  fail(when: RegExp, error: Record<string, unknown> = {}): void {
    this.failure = { when, error }
  }

  /** Starts PGlite and applies the schema. Call it in a beforeAll with a long timeout, before any hook that queries. */
  async ready(): Promise<void> {
    await this.query('SELECT 1')
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, [path.join(__dirname, 'pg-bridge.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: child.stdout }).on('line', (line) => {
      const reply: Reply = JSON.parse(line)
      this.pending.get(reply.id)?.(reply)
      this.pending.delete(reply.id)
    })
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    this.child = child
    return child
  }

  query = async (text: string, values: unknown[] = []): Promise<QueryResult> => {
    if (this.failure?.when.test(text)) {
      const { error } = this.failure
      this.failure = null
      throw Object.assign(new Error('injected database failure'), error)
    }
    const child = this.child ?? this.start()
    const id = this.nextId++
    const reply = await new Promise<Reply>((resolve) => {
      this.pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ id, text, values })}\n`)
    })
    if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error)
    return { rows: reply.rows ?? [], rowCount: reply.rowCount ?? 0 }
  }

  /** The pg module, for jest.mock. */
  pgModule() {
    const query = this.query
    class Pool {
      query = query
      async connect() {
        return { query, release: () => {} }
      }
    }
    return { Pool }
  }

  stop(): void {
    this.child?.stdin.end()
    this.child = null
  }
}

/** The one bridge of a test file. jest.mock factories reach it through require. */
export const bridge = new PgBridge()
