import { jest } from '@jest/globals'
import knex, { Knex } from 'knex'
import * as fc from 'fast-check'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const migration = require('../../db/migrations/20260227000000_fix_vault_schema.cjs')

type TableName = 'vaults' | 'milestones'

interface FakeState {
  columns: Record<TableName, Set<string>>
  indexes: Set<string>
  rawSql: string[]
  logs: string[]
  draftRows: number
}

function makeColumnChain() {
  return {
    nullable: () => makeColumnChain(),
    notNullable: () => makeColumnChain(),
    defaultTo: () => makeColumnChain(),
  }
}

function makeTableBuilder(table: TableName, state: FakeState) {
  const addColumn = (column: string) => {
    state.columns[table].add(column)
    return makeColumnChain()
  }

  return {
    string: (column: string) => addColumn(column),
    timestamp: (column: string) => addColumn(column),
    integer: (column: string) => addColumn(column),
    decimal: (column: string) => addColumn(column),
    index: (_columns: string[], name: string) => state.indexes.add(name),
    dropIndex: (_columns: string[], name: string) => state.indexes.delete(name),
    dropColumn: (column: string) => state.columns[table].delete(column),
  }
}

function makeFakeKnex(initial?: Partial<FakeState>) {
  const state: FakeState = {
    columns: {
      vaults: new Set(['id', 'start_timestamp', 'end_timestamp', 'status']),
      milestones: new Set(['id', 'vault_id']),
    },
    indexes: new Set(['idx_vaults_end_timestamp']),
    rawSql: [],
    logs: [],
    draftRows: 0,
    ...initial,
  }

  const fakeKnex = {
    fn: {
      now: () => 'NOW()',
    },
    schema: {
      alterTable: async (table: TableName, callback: (builder: ReturnType<typeof makeTableBuilder>) => void) => {
        callback(makeTableBuilder(table, state))
      },
    },
    raw: async (sql: string, params?: string[]) => {
      state.rawSql.push(sql)

      if (sql === 'SHOW server_version') {
        return { rows: [{ server_version: '14.5' }] }
      }

      if (sql.includes('information_schema.columns')) {
        const [table, column] = params as [TableName, string]
        return { rows: state.columns[table].has(column) ? [{ exists: 1 }] : [] }
      }

      if (sql.includes('pg_indexes')) {
        const [indexName] = params as [string]
        return { rows: state.indexes.has(indexName) ? [{ exists: 1 }] : [] }
      }

      if (sql.includes('SELECT COUNT(*) AS cnt FROM vaults')) {
        return { rows: [{ cnt: String(state.draftRows) }] }
      }

      if (sql.includes('RENAME COLUMN start_timestamp TO start_date')) {
        state.columns.vaults.delete('start_timestamp')
        state.columns.vaults.add('start_date')
      }

      if (sql.includes('RENAME COLUMN end_timestamp TO end_date')) {
        state.columns.vaults.delete('end_timestamp')
        state.columns.vaults.add('end_date')
      }

      if (sql.includes('RENAME COLUMN end_date TO end_timestamp')) {
        state.columns.vaults.delete('end_date')
        state.columns.vaults.add('end_timestamp')
      }

      if (sql.includes('RENAME COLUMN start_date TO start_timestamp')) {
        state.columns.vaults.delete('start_date')
        state.columns.vaults.add('start_timestamp')
      }

      return { rows: [] }
    },
  }

  return { knex: fakeKnex, state }
}

describe('fix_vault_schema migration', () => {
  let consoleSpy: jest.SpyInstance

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('runs outside a Knex transaction because ALTER TYPE ADD VALUE is transaction-sensitive', () => {
    expect(migration.config).toEqual({ transaction: false })
  })

  it('aligns vaults and milestones columns plus the end-date index in up', async () => {
    const { knex, state } = makeFakeKnex()

    await migration.up(knex)

    expect(state.columns.vaults.has('start_date')).toBe(true)
    expect(state.columns.vaults.has('end_date')).toBe(true)
    expect(state.columns.vaults.has('verifier')).toBe(true)
    expect(state.columns.vaults.has('updated_at')).toBe(true)
    expect(state.columns.vaults.has('start_timestamp')).toBe(false)
    expect(state.columns.vaults.has('end_timestamp')).toBe(false)

    expect(state.columns.milestones.has('sort_order')).toBe(true)
    expect(state.columns.milestones.has('amount')).toBe(true)
    expect(state.columns.milestones.has('due_date')).toBe(true)

    expect(state.indexes.has('idx_vaults_end_timestamp')).toBe(false)
    expect(state.indexes.has('idx_vaults_end_date')).toBe(true)
    expect(state.rawSql).toContain("ALTER TYPE vault_status ADD VALUE IF NOT EXISTS 'draft'")
    expect(state.rawSql).toContain("ALTER TABLE vaults ALTER COLUMN status SET DEFAULT 'draft'")
  })

  it('restores rollback-safe vault columns and index in down', async () => {
    const { knex, state } = makeFakeKnex({
      columns: {
        vaults: new Set(['id', 'start_date', 'end_date', 'status', 'verifier', 'updated_at']),
        milestones: new Set(['id', 'vault_id', 'sort_order', 'amount', 'due_date']),
      },
      indexes: new Set(['idx_vaults_end_date']),
      rawSql: [],
      logs: [],
      draftRows: 2,
    })

    await migration.down(knex)

    expect(state.rawSql).toContain("UPDATE vaults SET status = 'active' WHERE status = 'draft'")
    expect(state.rawSql.join('\n')).toContain('CREATE TYPE vault_status AS ENUM')

    expect(state.columns.vaults.has('start_timestamp')).toBe(true)
    expect(state.columns.vaults.has('end_timestamp')).toBe(true)
    expect(state.columns.vaults.has('start_date')).toBe(false)
    expect(state.columns.vaults.has('end_date')).toBe(false)
    expect(state.columns.vaults.has('verifier')).toBe(false)
    expect(state.columns.vaults.has('updated_at')).toBe(false)

    expect(state.columns.milestones.has('sort_order')).toBe(false)
    expect(state.columns.milestones.has('amount')).toBe(false)
    expect(state.columns.milestones.has('due_date')).toBe(false)

    expect(state.indexes.has('idx_vaults_end_date')).toBe(false)
    expect(state.indexes.has('idx_vaults_end_timestamp')).toBe(true)
  })

  it('emits structured migration logs without Stellar address-like values', async () => {
    const { knex } = makeFakeKnex()

    await migration.up(knex)

    const logs = consoleSpy.mock.calls.map(([entry]) => String(entry))
    expect(logs.length).toBeGreaterThan(0)

    for (const entry of logs) {
      expect(() => JSON.parse(entry)).not.toThrow()
      expect(entry).not.toMatch(/\bG[A-Z0-9]{55}\b/)
    }
  })
})

// ─── Real-DB property tests ─────────────────────────────────────────────────

// These tests exercise the migration against a live PostgreSQL instance.
// They skip gracefully when DATABASE_URL is not set (e.g. local dev without a DB).

let db: Knex | null = null

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL not set — skipping real-DB migration property tests')
    return
  }
  db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    acquireConnectionTimeout: 5_000,
  })
  try {
    await db.raw('SELECT 1')
  } catch {
    console.warn('⚠️  Cannot connect to DATABASE_URL — skipping real-DB migration property tests')
    await db.destroy()
    db = null
  }
}, 15_000)

afterAll(async () => {
  if (db) await db.destroy()
})

// vaultStore.ts INSERT column list (from tasks.md Property 3)
const VAULT_STORE_COLUMNS = [
  'id', 'amount', 'start_date', 'end_date', 'verifier',
  'success_destination', 'failure_destination', 'creator', 'status',
] as const

type VaultRow = Record<string, unknown>

function makeArbVaultRow(): fc.Arbitrary<VaultRow> {
  return fc.record({
    id: fc.uuid(),
    amount: fc.nat({ max: 100_000 }).map((n) => `${n}.0000000`),
    start_date: fc.constant(new Date('2024-01-01T00:00:00Z')),
    end_date: fc.constant(new Date('2024-12-31T23:59:59Z')),
    verifier: fc.string({ minLength: 1, maxLength: 20, unit: 'alpha' }),
    success_destination: fc.constant('GSUOD426DTNGKXZ7M6S5LQW3CPGHOQVU5BQVYOBPCNF5W5Z6KHL5X7YZ'),
    failure_destination: fc.constant('GAZXV5BQJ3W7MJ6R2GC3RZQ2S3Z6P2J5U4Z5W6V7X8Y9A0B1C2D3E4F'),
    creator: fc.constant('GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB'),
    status: fc.constant('draft'),
  })
}

async function getVaultColumns(knex: Knex): Promise<Set<string>> {
  const { rows } = await knex.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'vaults' ORDER BY ordinal_position`,
  )
  return new Set(rows.map((r: { column_name: string }) => r.column_name))
}

async function getVaultIndexes(knex: Knex): Promise<Set<string>> {
  const { rows } = await knex.raw(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'vaults' ORDER BY indexname`,
  )
  return new Set(rows.map((r: { indexname: string }) => r.indexname))
}

async function insertVault(knex: Knex, row: VaultRow): Promise<void> {
  const columns = VAULT_STORE_COLUMNS.filter((c) => row[c] !== undefined)
  const values = columns.map((c) => row[c])
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
  const cols = columns.join(', ')
  await knex.raw(`INSERT INTO vaults (${cols}) VALUES (${placeholders})`, values)
}

async function vaultExistsWithStatus(knex: Knex, id: string, status: string): Promise<boolean> {
  const { rows } = await knex.raw(
    `SELECT 1 FROM vaults WHERE id = $1 AND status = $2`,
    [id, status],
  )
  return rows.length > 0
}

async function countDraftRows(knex: Knex): Promise<number> {
  const { rows } = await knex.raw(`SELECT COUNT(*)::int AS cnt FROM vaults WHERE status = 'draft'`)
  return rows[0].cnt
}

async function cleanupVaults(knex: Knex): Promise<void> {
  await knex.raw('DELETE FROM vaults WHERE 1=1')
}

// Feature: vault-migrations, Property 1: column set round-trip
describe('fix_vault_schema — real-DB property tests', () => {
  it('Property 1: column set round-trip', async () => {
    if (!db) return

    const colsBefore = await getVaultColumns(db)
    expect(colsBefore.size).toBeGreaterThan(0)

    await migration.up(db)
    await migration.down(db)

    const colsAfter = await getVaultColumns(db)
    expect(colsAfter).toEqual(colsBefore)
  })

  // Feature: vault-migrations, Property 2: draft status insert succeeds after up
  it('Property 2: draft status insert succeeds after up', async () => {
    if (!db) return

    await migration.up(db)

    await fc.assert(
      fc.asyncProperty(makeArbVaultRow(), async (row) => {
        await insertVault(db!, row)
        const exists = await vaultExistsWithStatus(db!, row.id as string, 'draft')
        expect(exists).toBe(true)
      }),
      { numRuns: 20 },
    )

    await cleanupVaults(db)
    await migration.down(db)
  })

  // Feature: vault-migrations, Property 3: vaultStore column list compatibility
  it('Property 3: vaultStore column list compatibility', async () => {
    if (!db) return

    await migration.up(db)

    await fc.assert(
      fc.asyncProperty(makeArbVaultRow(), async (row) => {
        await insertVault(db!, row)
        const exists = await vaultExistsWithStatus(db!, row.id as string, 'draft')
        expect(exists).toBe(true)
      }),
      { numRuns: 20 },
    )

    await cleanupVaults(db)
    await migration.down(db)
  })

  // Feature: vault-migrations, Property 4: rollback draft-row guard
  it('Property 4: rollback draft-row guard', async () => {
    if (!db) return

    await migration.up(db)

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        async (draftCount) => {
          // Insert N draft rows
          const rows = Array.from({ length: draftCount }, (_, i) => ({
            id: `test-draft-${i}-${Date.now()}`,
            amount: '100.0000000',
            start_date: new Date('2024-01-01'),
            end_date: new Date('2024-12-31'),
            verifier: 'test-verifier',
            success_destination: 'GSUCCESS00000000000000000000000000000000000000000000000',
            failure_destination: 'GFAILURE00000000000000000000000000000000000000000000000',
            creator: 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB',
            status: 'draft',
          }))

          for (const row of rows) {
            await insertVault(db!, row)
          }

          const draftBefore = await countDraftRows(db!)
          expect(draftBefore).toBe(draftCount)

          // down() should not throw
          await expect(migration.down(db!)).resolves.not.toThrow()

          // Revert schema for next iteration
          await cleanupVaults(db!)
          await migration.up(db!)
        },
      ),
      { numRuns: 5 },
    )

    await cleanupVaults(db)
    await migration.down(db)
  })

  // Feature: vault-migrations, Property 5: index consistency after up and down
  it('Property 5: index consistency after up and down', async () => {
    if (!db) return

    const indexesBefore = await getVaultIndexes(db)

    await migration.up(db)
    await migration.down(db)

    const indexesAfter = await getVaultIndexes(db)
    expect(indexesAfter).toEqual(indexesBefore)
  })

  // Feature: vault-migrations, Property 6: log entries contain no PII
  it('Property 6: log entries contain no PII', async () => {
    if (!db) return

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await migration.up(db)
      await migration.down(db)

      const logs = logSpy.mock.calls.map(([entry]) => String(entry))
      for (const entry of logs) {
        expect(entry).not.toMatch(/\bG[A-Z2-7]{55}\b/)
      }
    } finally {
      logSpy.mockRestore()
    }
  })
})
