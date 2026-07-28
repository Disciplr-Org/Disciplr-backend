import { createRequire } from 'node:module'
import knex, { Knex } from 'knex'
import { captureSlowQuery } from '../services/dbMetrics.js'

// Portable CJS/ESM require. In Jest's CJS runner import.meta is a parse-time
// SyntaxError, so we hide it behind eval() which the CJS parser treats as a
// regular function call string. typeof require guards the branch at runtime:
//   - CJS (Jest):     typeof require !== 'undefined' → uses global require
//   - ESM (tsx/prod):  typeof require === 'undefined' → eval branch runs
const nodeRequire: NodeRequire =
  typeof require !== 'undefined'
    ? require
    : // eslint-disable-next-line no-eval
      createRequire(eval('import.meta.url'))
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
