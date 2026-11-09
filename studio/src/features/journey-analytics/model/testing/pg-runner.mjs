// Runs SQL against an in-memory Postgres (PGlite) with infra/db/schema.sql applied. Jest cannot
// load PGlite inside its VM, so pg.ts runs this file in a plain node process.
// stdin: { "setup": "<fixture SQL>", "queries": [{ "text": "...", "values": [...] }] }
// stdout: the rows of each query, in order.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const schema = readFileSync(new URL('../../../../../../infra/db/schema.sql', import.meta.url), 'utf8')
const { setup, queries } = JSON.parse(readFileSync(0, 'utf8'))

const db = new PGlite()
try {
  await db.exec(schema)
  await db.exec(setup)
  const results = []
  for (const query of queries) results.push((await db.query(query.text, query.values)).rows)
  process.stdout.write(JSON.stringify(results, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)))
} finally {
  await db.close()
}
