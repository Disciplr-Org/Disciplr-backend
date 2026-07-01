import { createRequire } from 'module'
import knex, { Knex } from 'knex'
import { captureSlowQuery } from '../services/dbMetrics.js'

const nodeRequire = createRequire(import.meta.url)
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
