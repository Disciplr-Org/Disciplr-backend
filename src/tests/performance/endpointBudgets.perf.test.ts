import { describe, expect, it } from '@jest/globals'
import {
  ENDPOINT_PERFORMANCE_BUDGETS,
  assertIndexedPlan,
  getPerformanceBudget,
  type PerformanceEndpointKey,
} from '../helpers/performanceHelpers.js'

const listEndpointScenarios: PerformanceEndpointKey[] = [
  'vaults.list',
  'vaults.deepPagination',
  'vaults.combinedSortFilter',
  'transactions.list',
  'transactions.cursorPagination',
  'transactions.byVault',
  'transactions.combinedSortFilter',
  'analytics.summary',
  'analytics.overview',
  'analytics.vaults',
  'analytics.milestoneTrends',
  'analytics.behavior',
]

describe('performance endpoint budget contract', () => {
  it('defines budgets for every documented list endpoint scenario', () => {
    expect(Object.keys(ENDPOINT_PERFORMANCE_BUDGETS).sort()).toEqual([...listEndpointScenarios].sort())

    for (const scenario of listEndpointScenarios) {
      const budget = getPerformanceBudget(scenario)
      expect(budget.label).toContain('GET /api/')
      expect(budget.maxResponseTime).toBeGreaterThan(0)
      expect(budget.maxQueryCount).toBeGreaterThan(0)
    }
  })

  it('requires indexes for database-backed vault and transaction scenarios', () => {
    const databaseBacked = listEndpointScenarios.filter(
      (scenario) => scenario.startsWith('vaults.') || scenario.startsWith('transactions.'),
    )

    for (const scenario of databaseBacked) {
      expect(getPerformanceBudget(scenario).expectedIndexes.length).toBeGreaterThan(0)
    }
  })

  it('keeps analytics constant-time scenarios explicit about sequential scans', () => {
    expect(getPerformanceBudget('analytics.overview').allowSequentialScan).toBe(true)
    expect(getPerformanceBudget('analytics.milestoneTrends').allowSequentialScan).toBe(true)
    expect(getPerformanceBudget('analytics.behavior').allowSequentialScan).toBe(true)
  })

  it('validates representative index plans for the configured transaction budget', () => {
    const budget = getPerformanceBudget('transactions.combinedSortFilter')
    const plan = [
      {
        Plan: {
          'Node Type': 'Index Scan',
          'Index Name': 'idx_transactions_type_created_at',
        },
      },
    ]

    expect(() =>
      assertIndexedPlan(plan, {
        expectedIndexes: [budget.expectedIndexes[0]!],
      }),
    ).not.toThrow()
  })
})
