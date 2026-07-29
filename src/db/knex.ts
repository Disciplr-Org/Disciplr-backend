import { createRequire } from 'node:module'
import knex, { Knex } from 'knex'
import { captureSlowQuery } from '../services/dbMetrics.js'

// Portable CJS/ESM require. This module is always evaluated as native ESM
// (tsx in dev, ts-jest useESM in tests, tsc "module": "NodeNext" in prod),
// so `import.meta.url` is valid directly here — no eval() indirection
// needed (eval'd strings don't inherit module-goal parsing, which made
// `eval('import.meta.url')` throw under ts-jest's ESM runner).
//   - tsx (dev):       shims a global `require` → typeof require !== 'undefined'
//   - ts-jest / tsc:   no global `require` → falls through to import.meta.url
const nodeRequire: NodeRequire =
  typeof require !== 'undefined' ? require : createRequire(import.meta.url)
const config = nodeRequire('../../knexfile.cjs')

export const db: Knex = knex(config)

// Track query start times keyed by Knex's internal __knexQueryUid
const queryStart = new Map<string, number>()

db.on('query', (q: { __knexQueryUid: string }) => {
  queryStart.set(q.__knexQueryUid, Date.now())
})

function finish(q: { __knexQueryUid: string; sql: string }): void {
  const start = queryStart.get(q.__knexQueryUid)
  if (start === undefined) return
  queryStart.delete(q.__knexQueryUid)
  captureSlowQuery(q.sql, Date.now() - start)
}

db.on('query-response', (_response: unknown, q: { __knexQueryUid: string; sql: string }) => {
  finish(q)
})

db.on('query-error', (_error: unknown, q: { __knexQueryUid: string; sql: string }) => {
  finish(q)
})

export async function closeDatabase(): Promise<void> {
  await db.destroy()
}
