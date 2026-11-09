// An in-memory Postgres (PGlite) with infra/db/schema.sql applied, serving one JSON request per
// line on stdin and answering one JSON line each on stdout. Jest cannot load PGlite inside its VM,
// so pg.ts runs this file in a plain node process and keeps it for a whole test file.
// Request: { "id": 1, "text": "...", "values": [...] }. Answer: { "id": 1, "rows": [...] } or
// { "id": 1, "error": "..." }.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PGlite } from '@electric-sql/pglite'

const schema = readFileSync(new URL('../../../../../../infra/db/schema.sql', import.meta.url), 'utf8')
const db = new PGlite()
await db.exec(schema)
process.stdout.write(`${JSON.stringify({ ready: true })}\n`)

const toJson = (_key, value) => (typeof value === 'bigint' ? Number(value) : value)
let queue = Promise.resolve()
for await (const line of createInterface({ input: process.stdin })) {
  const { id, text, values } = JSON.parse(line)
  queue = queue.then(async () => {
    try {
      const rows = values === undefined ? (await db.exec(text)).at(-1)?.rows ?? [] : (await db.query(text, values)).rows
      process.stdout.write(`${JSON.stringify({ id, rows }, toJson)}\n`)
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id, error: String(error?.message ?? error) })}\n`)
    }
  })
}
await queue
await db.close()
