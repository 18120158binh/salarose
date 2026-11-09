// An in-memory Postgres (PGlite) with infra/db/schema.sql applied, driven one statement at a time.
// Jest cannot load PGlite inside its VM, so pgBridge.ts runs this file in a plain node process.
// stdin: one JSON request per line, { "id": 1, "text": "...", "values": [...] }
// stdout: one JSON reply per line, { "id": 1, "rows": [...], "rowCount": 1 } or { "id": 1, "error": {...} }
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PGlite } from '@electric-sql/pglite'

const schema = readFileSync(new URL('../../../../infra/db/schema.sql', import.meta.url), 'utf8')
const db = new PGlite()
await db.exec(schema)

const reply = (message) =>
  process.stdout.write(`${JSON.stringify(message, (_key, value) => (typeof value === 'bigint' ? Number(value) : value))}\n`)

let queue = Promise.resolve()
for await (const line of createInterface({ input: process.stdin })) {
  const { id, text, values } = JSON.parse(line)
  queue = queue.then(async () => {
    try {
      const result = await db.query(text, values)
      reply({ id, rows: result.rows, rowCount: result.affectedRows ?? result.rows.length })
    } catch (error) {
      reply({ id, error: { message: error.message, code: error.code, constraint: error.constraint } })
    }
  })
}
await queue
await db.close()
