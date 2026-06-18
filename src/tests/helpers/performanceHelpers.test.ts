import { describe, expect, it } from '@jest/globals'
import {
  PERFORMANCE_BUDGETS,
  analyseQueryPlan,
  assertIndexedQueryPlan,
  assertPerformance,
  assertQueryCount,
  evaluatePerformanceThresholds,
  getPerformanceBudget
} from './performanceHelpers.js'

describe('performanceHelpers', () => {
  it('defines endpoint-specific budgets instead of a single blanket threshold', () => {
    expect(getPerformanceBudget('vaults.filteredByStatus')).toMatchObject({
      endpoint: 'GET /api/vaults?status=active&sortBy=endTimestamp',
      maxResponseTime: 1500,
      maxQueryCount: 6,
      expectedIndexes: ['idx_vaults_status_end_date']
    })

    expect(PERFORMANCE_BUDGETS['analytics.summary'].maxResponseTime).toBeLessThan(
      PERFORMANCE_BUDGETS['vaults.deepPage'].maxResponseTime
    )
  })

  it('reports both response-time and query-count budget violations', () => {
    const result = evaluatePerformanceThresholds(
      1750,
      { maxResponseTime: 1000, maxQueryCount: 3 },
      5
    )

    expect(result.passed).toBe(false)
    expect(result.violations).toEqual([
      'Response time 1750ms exceeded threshold 1000ms',
      'Query count 5 exceeded threshold 3'
    ])
  })

  it('keeps existing assertPerformance error context intact', () => {
    const result = evaluatePerformanceThresholds(2500, { maxResponseTime: 1000 })

    expect(() => assertPerformance(result, 'vaults_list')).toThrow(
      'Performance test "vaults_list" failed: Response time 2500ms exceeded threshold 1000ms. Response time: 2500ms'
    )
  })

  it('rejects query-count regressions independently from response time', () => {
    expect(() => assertQueryCount(9, { maxResponseTime: 1000, maxQueryCount: 6 }, 'transactions_list'))
      .toThrow('Performance test "transactions_list" failed: Query count 9 exceeded threshold 6')

    expect(() => assertQueryCount(6, { maxResponseTime: 1000, maxQueryCount: 6 }, 'transactions_list'))
      .not.toThrow()
  })

  it('extracts indexes from PostgreSQL JSON explain plans', () => {
    const plan = [
      {
        'QUERY PLAN': [
          {
            Plan: {
              'Node Type': 'Nested Loop',
              Plans: [
                {
                  'Node Type': 'Index Scan',
                  'Index Name': 'idx_vaults_status_end_date',
                  'Relation Name': 'vaults'
                },
                {
                  'Node Type': 'Index Only Scan',
                  'Index Name': 'idx_transactions_vault_id',
                  'Relation Name': 'transactions'
                }
              ]
            }
          }
        ]
      }
    ]

    const analysis = assertIndexedQueryPlan(
      plan,
      { maxResponseTime: 1500, expectedIndexes: ['idx_vaults_status_end_date', 'idx_transactions_vault_id'] },
      'indexed_join'
    )

    expect(analysis.nodeTypes).toEqual(['Nested Loop', 'Index Scan', 'Index Only Scan'])
    expect(analysis.usedIndexes).toEqual(['idx_vaults_status_end_date', 'idx_transactions_vault_id'])
    expect(analysis.sequentialScanTables).toEqual([])
  })

  it('rejects sequential scans and missing expected indexes', () => {
    const plan = [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'transactions'
        }
      }
    ]

    expect(() =>
      assertIndexedQueryPlan(
        plan,
        { maxResponseTime: 1500, expectedIndexes: ['idx_transactions_stellar_timestamp'] },
        'transactions_date_filter'
      )
    ).toThrow(
      'Performance query plan "transactions_date_filter" failed: Sequential scan detected on transactions, Expected index idx_transactions_stellar_timestamp was not used'
    )
  })

  it('allows documented sequential scans for aggregate-only analytics budgets', () => {
    const plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'analytics_vault_summary' } }]

    const analysis = assertIndexedQueryPlan(
      plan,
      { maxResponseTime: 750, allowSequentialScan: true },
      'analytics_summary'
    )

    expect(analysis.sequentialScanTables).toEqual(['analytics_vault_summary'])
  })

  it('parses text explain output from local debugging sessions', () => {
    const textPlan = `
Limit
  ->  Index Scan using idx_transactions_type_created_at on transactions
        Index Cond: (type = 'deposit'::text)
`

    expect(analyseQueryPlan(textPlan)).toEqual({
      nodeTypes: ['Index Scan'],
      usedIndexes: ['idx_transactions_type_created_at'],
      sequentialScanTables: []
    })
  })
})
