import { createRequire } from 'node:module'
import { jest } from '@jest/globals'

const require = createRequire(import.meta.url)

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
