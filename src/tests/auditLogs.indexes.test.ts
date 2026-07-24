import { describe, it, expect, beforeAll } from '@jest/globals'
import { db } from '../db/knex.js'

describe('Audit Logs Indexes', () => {
  let hasDb = false

  beforeAll(async () => {
    try {
      // Quick connectivity check; if it fails, we'll skip the DB-specific test
      await db.raw('select 1')
      hasDb = true
    } catch (error) {
      // No DB available in this environment (e.g., local developer machine without DATABASE_URL)
      // The index verification is only meaningful when running against a PostgreSQL instance.
      hasDb = false
    }
  })

  it('has composite index on organization_id and created_at', async () => {
    if (!hasDb) {
      console.warn('Skipping index existence test: no DB connection available')
      return
    }

    const rows = await db('pg_indexes').select('indexname', 'indexdef').where({ tablename: 'audit_logs' })
    const found = rows.some((r: any) => {
      const def = String(r.indexdef || '').toLowerCase()
      return def.includes('organization_id') && def.includes('created_at')
    })

    expect(found).toBe(true)
  })
})
