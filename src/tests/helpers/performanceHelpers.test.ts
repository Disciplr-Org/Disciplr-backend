import { describe, expect, it, jest } from '@jest/globals'
import type { Knex } from 'knex'
import {
  ENDPOINT_PERFORMANCE_BUDGETS,
  assertIndexedPlan,
  assertPerformance,
  collectPerformanceViolations,
  explainQueryPlan,
  getPerformanceBudget,
  measureEndpointPerformance,
  measurePerformance,
  summarizeExplainPlan,
  trackQueries,
} from './performanceHelpers.js'

interface MockKnex extends Knex {
  emitQuery: () => void
}

function makeMockKnex(rawResult?: unknown): MockKnex {
  const handlers = new Map<string, Array<() => void>>()
  const db: Partial<Knex> & { emitQuery?: () => void } = {}

  db.on = jest.fn((event: string, handler: () => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler])
    return db as Knex
  }) as unknown as Knex['on']
  db.off = jest.fn((event: string, handler: () => void) => {
    handlers.set(
      event,
      (handlers.get(event) ?? []).filter((registered) => registered !== handler),
    )
    return db as Knex
  }) as unknown as Knex['off']
  db.raw = jest.fn(async () => rawResult) as unknown as Knex['raw']

  db.emitQuery = () => {
    for (const handler of handlers.get('query') ?? []) handler()
  }

  return db as MockKnex
}

const indexedPlan = [
  {
    Plan: {
      'Node Type': 'Nested Loop',
      Plans: [
        {
          'Node Type': 'Index Scan',
          'Index Name': 'idx_transactions_stellar_timestamp',
        },
        {
          'Node Type': 'Index Only Scan',
          'Index Name': 'idx_transactions_type_created_at',
        },
      ],
    },
  },
]

describe('performance budget helpers', () => {
  it('defines per-endpoint response-time and query-count budgets', () => {
    expect(ENDPOINT_PERFORMANCE_BUDGETS['vaults.list']).toMatchObject({
      maxResponseTime: expect.any(Number),
      maxQueryCount: expect.any(Number),
      expectedIndexes: expect.arrayContaining(['idx_vaults_status_end_date']),
    })
    expect(ENDPOINT_PERFORMANCE_BUDGETS['transactions.combinedSortFilter'].expectedIndexes).toEqual(
      expect.arrayContaining(['idx_transactions_type_created_at']),
    )
    expect(ENDPOINT_PERFORMANCE_BUDGETS['analytics.overview'].allowSequentialScan).toBe(true)
  })

  it('returns a budget with safe overrides', () => {
    expect(
      getPerformanceBudget('transactions.list', {
        maxResponseTime: 123,
        expectedIndexes: ['idx_custom'],
      }),
    ).toMatchObject({
      label: 'GET /api/transactions list page',
      maxResponseTime: 123,
      maxQueryCount: 5,
      expectedIndexes: ['idx_custom'],
    })
  })

  it('collects response-time and query-count violations', () => {
    expect(collectPerformanceViolations({ responseTime: 20, queryCount: 2 }, { maxResponseTime: 50, maxQueryCount: 3 }))
      .toEqual([])

    expect(collectPerformanceViolations({ responseTime: 60, queryCount: 4 }, { maxResponseTime: 50, maxQueryCount: 3 }))
      .toEqual([
        'Response time 60ms exceeded threshold 50ms',
        'Query count 4 exceeded threshold 3',
      ])
  })
})

describe('performance measurement helpers', () => {
  it('measures successful operations', async () => {
    const result = await measurePerformance(async () => undefined, { maxResponseTime: 1000 })

    expect(result.passed).toBe(true)
    expect(result.responseTime).toBeGreaterThanOrEqual(0)
  })

  it('preserves operation errors while measuring response time', async () => {
    await expect(
      measurePerformance(async () => {
        throw new Error('operation failed')
      }, { maxResponseTime: 1000 }),
    ).rejects.toThrow('operation failed')
  })

  it('tracks Knex query events and removes the listener after the operation', async () => {
    const db = makeMockKnex()
    const count = await trackQueries(db, async () => {
      db.emitQuery()
      db.emitQuery()
    })

    expect(count).toBe(2)
    expect(db.on).toHaveBeenCalledWith('query', expect.any(Function))
    expect(db.off).toHaveBeenCalledWith('query', expect.any(Function))

    db.emitQuery()
    expect(count).toBe(2)
  })

  it('returns query-count violations from endpoint measurements', async () => {
    const db = makeMockKnex()
    const result = await measureEndpointPerformance(
      db,
      async () => {
        db.emitQuery()
        db.emitQuery()
      },
      { maxResponseTime: 1000, maxQueryCount: 1 },
    )

    expect(result.queryCount).toBe(2)
    expect(result.passed).toBe(false)
    expect(result.violations).toContain('Query count 2 exceeded threshold 1')
  })

  it('throws readable assertion errors for failed performance results', () => {
    expect(() =>
      assertPerformance(
        {
          responseTime: 1500,
          queryCount: 8,
          passed: false,
          violations: ['Response time 1500ms exceeded threshold 1000ms'],
        },
        'vaults.list',
      ),
    ).toThrow('Performance test "vaults.list" failed')
  })
})

describe('EXPLAIN plan helpers', () => {
  it('summarizes nested EXPLAIN JSON plans', () => {
    expect(summarizeExplainPlan(indexedPlan)).toEqual({
      nodeTypes: ['Nested Loop', 'Index Scan', 'Index Only Scan'],
      indexNames: ['idx_transactions_stellar_timestamp', 'idx_transactions_type_created_at'],
    })
  })

  it('passes when the expected indexes are present and no sequential scan is used', () => {
    expect(
      assertIndexedPlan(indexedPlan, {
        expectedIndexes: ['idx_transactions_stellar_timestamp'],
      }),
    ).toMatchObject({
      indexNames: expect.arrayContaining(['idx_transactions_stellar_timestamp']),
    })
  })

  it('fails when a sequential scan appears without an explicit allowance', () => {
    expect(() =>
      assertIndexedPlan([{ Plan: { 'Node Type': 'Seq Scan' } }], {
        expectedIndexes: [],
      }),
    ).toThrow('EXPLAIN plan used Seq Scan')
  })

  it('allows sequential scans for constant-time analytics endpoints', () => {
    expect(assertIndexedPlan([{ Plan: { 'Node Type': 'Seq Scan' } }], { allowSequentialScan: true }))
      .toEqual({ nodeTypes: ['Seq Scan'], indexNames: [] })
  })

  it('fails when an expected index is missing', () => {
    expect(() =>
      assertIndexedPlan(indexedPlan, {
        expectedIndexes: ['idx_missing'],
      }),
    ).toThrow('did not use expected index "idx_missing"')
  })

  it('extracts JSON plans from pg-style raw results', async () => {
    const db = makeMockKnex({
      rows: [
        {
          'QUERY PLAN': indexedPlan,
        },
      ],
    })

    await expect(explainQueryPlan(db, 'SELECT * FROM transactions WHERE type = ?', ['deposit']))
      .resolves.toBe(indexedPlan)
    expect(db.raw).toHaveBeenCalledWith(
      'EXPLAIN (FORMAT JSON) SELECT * FROM transactions WHERE type = ?',
      ['deposit'],
    )
  })

  it('extracts JSON plans from mysql-style raw results', async () => {
    const db = makeMockKnex([[{ query_plan: indexedPlan }]])

    await expect(explainQueryPlan(db, 'SELECT 1')).resolves.toBe(indexedPlan)
  })
})
