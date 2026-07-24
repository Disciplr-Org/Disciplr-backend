import { Knex } from 'knex'

/**
 * Performance test helpers for smoke testing list endpoints
 * These utilities help detect N+1 queries and missing indexes
 */

export interface PerformanceThresholds {
  /** Maximum acceptable response time in milliseconds */
  maxResponseTime: number
  /** Maximum acceptable query count (if available) */
  maxQueryCount?: number
}

export type PerformanceEndpointKey =
  | 'vaults.list'
  | 'vaults.deepPagination'
  | 'vaults.combinedSortFilter'
  | 'transactions.list'
  | 'transactions.cursorPagination'
  | 'transactions.byVault'
  | 'transactions.combinedSortFilter'
  | 'analytics.summary'
  | 'analytics.overview'
  | 'analytics.vaults'
  | 'analytics.milestoneTrends'
  | 'analytics.behavior'

export interface EndpointPerformanceBudget extends PerformanceThresholds {
  /** Human-readable endpoint/scenario label for logs and docs */
  label: string
  /** Indexes that should appear in representative EXPLAIN plans */
  expectedIndexes: string[]
  /** Whether a sequential scan is acceptable for this scenario */
  allowSequentialScan?: boolean
}

export const ENDPOINT_PERFORMANCE_BUDGETS: Record<PerformanceEndpointKey, EndpointPerformanceBudget> = {
  'vaults.list': {
    label: 'GET /api/vaults list page',
    maxResponseTime: 750,
    maxQueryCount: 4,
    expectedIndexes: ['idx_vaults_status_end_date', 'idx_vaults_end_date'],
  },
  'vaults.deepPagination': {
    label: 'GET /api/vaults deep pagination',
    maxResponseTime: 1200,
    maxQueryCount: 6,
    expectedIndexes: ['idx_vaults_status_end_date'],
  },
  'vaults.combinedSortFilter': {
    label: 'GET /api/vaults status filter plus sort',
    maxResponseTime: 900,
    maxQueryCount: 5,
    expectedIndexes: ['idx_vaults_status_end_date'],
  },
  'transactions.list': {
    label: 'GET /api/transactions list page',
    maxResponseTime: 900,
    maxQueryCount: 5,
    expectedIndexes: ['idx_transactions_stellar_timestamp'],
  },
  'transactions.cursorPagination': {
    label: 'GET /api/transactions cursor page',
    maxResponseTime: 1000,
    maxQueryCount: 5,
    expectedIndexes: ['idx_transactions_stellar_timestamp'],
  },
  'transactions.byVault': {
    label: 'GET /api/transactions/vault/:vaultId',
    maxResponseTime: 900,
    maxQueryCount: 5,
    expectedIndexes: ['idx_transactions_stellar_timestamp'],
  },
  'transactions.combinedSortFilter': {
    label: 'GET /api/transactions type/date filter plus sort',
    maxResponseTime: 1100,
    maxQueryCount: 6,
    expectedIndexes: ['idx_transactions_type_created_at', 'idx_transactions_stellar_timestamp'],
  },
  'analytics.summary': {
    label: 'GET /api/analytics/summary',
    maxResponseTime: 350,
    maxQueryCount: 2,
    expectedIndexes: [],
    allowSequentialScan: true,
  },
  'analytics.overview': {
    label: 'GET /api/analytics/overview',
    maxResponseTime: 250,
    maxQueryCount: 1,
    expectedIndexes: [],
    allowSequentialScan: true,
  },
  'analytics.vaults': {
    label: 'GET /api/analytics/vaults',
    maxResponseTime: 350,
    maxQueryCount: 2,
    expectedIndexes: ['idx_vaults_status_end_date'],
  },
  'analytics.milestoneTrends': {
    label: 'GET /api/analytics/milestones/trends',
    maxResponseTime: 650,
    maxQueryCount: 3,
    expectedIndexes: [],
    allowSequentialScan: true,
  },
  'analytics.behavior': {
    label: 'GET /api/analytics/behavior',
    maxResponseTime: 650,
    maxQueryCount: 3,
    expectedIndexes: [],
    allowSequentialScan: true,
  },
}

export interface PerformanceResult {
  /** Response time in milliseconds */
  responseTime: number
  /** Number of database queries executed (if tracked) */
  queryCount?: number
  /** Whether the test passed thresholds */
  passed: boolean
  /** Details about threshold violations */
  violations: string[]
}

/**
 * Measure response time for an async operation
 * @param operation - The async operation to measure
 * @returns Performance result with timing information
 */
export async function measurePerformance(
  operation: () => Promise<unknown>,
  thresholds: PerformanceThresholds
): Promise<PerformanceResult> {
  const startTime = Date.now()
  await operation()
  
  const endTime = Date.now()
  const responseTime = endTime - startTime
  
  const violations: string[] = []
  
  if (responseTime > thresholds.maxResponseTime) {
    violations.push(
      `Response time ${responseTime}ms exceeded threshold ${thresholds.maxResponseTime}ms`
    )
  }
  
  return {
    responseTime,
    passed: violations.length === 0,
    violations
  }
}

export function getPerformanceBudget(
  endpoint: PerformanceEndpointKey,
  overrides: Partial<EndpointPerformanceBudget> = {},
): EndpointPerformanceBudget {
  return {
    ...ENDPOINT_PERFORMANCE_BUDGETS[endpoint],
    ...overrides,
    expectedIndexes: overrides.expectedIndexes ?? ENDPOINT_PERFORMANCE_BUDGETS[endpoint].expectedIndexes,
  }
}

/**
 * Track database queries during an operation
 * This is a simplified version - in production you'd use query logging
 * @param db - Knex database instance
 * @param operation - The operation to track
 * @returns Query count
 */
export async function trackQueries(
  db: Knex,
  operation: () => Promise<unknown>
): Promise<number> {
  let queryCount = 0
  
  // Hook into Knex query events
  const queryHandler = () => {
    queryCount++
  }
  
  db.on('query', queryHandler)
  
  try {
    await operation()
  } finally {
    db.off('query', queryHandler)
  }
  
  return queryCount
}

export async function measureEndpointPerformance(
  db: Knex,
  operation: () => Promise<unknown>,
  thresholds: PerformanceThresholds,
): Promise<PerformanceResult> {
  const startTime = Date.now()
  const queryCount = await trackQueries(db, operation)
  const responseTime = Date.now() - startTime
  const violations = collectPerformanceViolations({ responseTime, queryCount }, thresholds)

  return {
    responseTime,
    queryCount,
    passed: violations.length === 0,
    violations,
  }
}

export function collectPerformanceViolations(
  result: Pick<PerformanceResult, 'responseTime' | 'queryCount'>,
  thresholds: PerformanceThresholds,
): string[] {
  const violations: string[] = []

  if (result.responseTime > thresholds.maxResponseTime) {
    violations.push(
      `Response time ${result.responseTime}ms exceeded threshold ${thresholds.maxResponseTime}ms`
    )
  }

  if (
    typeof thresholds.maxQueryCount === 'number' &&
    typeof result.queryCount === 'number' &&
    result.queryCount > thresholds.maxQueryCount
  ) {
    violations.push(
      `Query count ${result.queryCount} exceeded threshold ${thresholds.maxQueryCount}`
    )
  }

  return violations
}

/**
 * Seed a large number of test records for performance testing
 * @param db - Knex database instance
 * @param tableName - Name of the table to seed
 * @param count - Number of records to create
 * @param recordFactory - Function that generates a record given an index
 */
export async function seedLargeDataset<T>(
  db: Knex,
  tableName: string,
  count: number,
  recordFactory: (index: number) => T
): Promise<void> {
  const batchSize = 1000
  const batches = Math.ceil(count / batchSize)
  
  for (let batch = 0; batch < batches; batch++) {
    const batchStart = batch * batchSize
    const batchEnd = Math.min(batchStart + batchSize, count)
    const records: T[] = []
    
    for (let i = batchStart; i < batchEnd; i++) {
      records.push(recordFactory(i))
    }
    
    await db(tableName).insert(records)
  }
}

/**
 * Generate a realistic test user
 * @param index - Index for generating unique values
 * @returns User record
 */
export function generateTestUser(index: number) {
  return {
    email: `perf-test-user-${index}@example.com`,
    password_hash: `hash_${index}`,
    role: 'USER',
    status: 'ACTIVE',
    created_at: new Date(Date.now() - index * 1000),
    updated_at: new Date(Date.now() - index * 1000)
  }
}

/**
 * Generate a realistic test vault
 * @param index - Index for generating unique values
 * @param userId - User ID to associate with the vault
 * @returns Vault record
 */
export function generateTestVault(index: number, userId: string) {
  const now = Date.now()
  const statuses = ['DRAFT', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED']
  
  return {
    id: `vault-perf-${index.toString().padStart(10, '0')}`,
    creator_id: userId,
    amount: (1000 + index).toString(),
    start_date: new Date(now - index * 10000),
    end_date: new Date(now + 86400000 + index * 10000), // +1 day
    verifier: `GVERIFIER${index.toString().padStart(50, 'X')}`,
    success_destination: `GSUCCESS${index.toString().padStart(50, 'X')}`,
    failure_destination: `GFAILURE${index.toString().padStart(50, 'X')}`,
    status: statuses[index % statuses.length],
    created_at: new Date(now - index * 10000),
    updated_at: new Date(now - index * 10000)
  }
}

/**
 * Generate a realistic test transaction
 * @param index - Index for generating unique values
 * @param userId - User ID to associate with the transaction
 * @param vaultId - Vault ID to associate with the transaction
 * @returns Transaction record
 */
export function generateTestTransaction(index: number, userId: string, vaultId: string) {
  const now = Date.now()
  const types = ['creation', 'deposit', 'withdrawal', 'completion']
  
  return {
    user_id: userId,
    vault_id: vaultId,
    tx_hash: `hash_perf_${index.toString().padStart(20, '0')}`,
    type: types[index % types.length],
    amount: (100 + index).toString(),
    asset_code: 'XLM',
    from_account: `GFROM${index.toString().padStart(50, 'X')}`,
    to_account: `GTO${index.toString().padStart(50, 'X')}`,
    memo: `Performance test transaction ${index}`,
    stellar_ledger: 1000000 + index,
    stellar_timestamp: new Date(now - index * 5000),
    explorer_url: `https://stellar.expert/explorer/testnet/tx/${index}`,
    created_at: new Date(now - index * 5000)
  }
}

/**
 * Clean up performance test data
 * @param db - Knex database instance
 * @param pattern - Pattern to match for cleanup (e.g., 'perf-test-%')
 */
export async function cleanupPerfTestData(db: Knex): Promise<void> {
  // Clean in order to respect foreign key constraints
  await db('transactions').where('tx_hash', 'like', 'hash_perf_%').del()
  await db('vaults').where('id', 'like', 'vault-perf-%').del()
  await db('users').where('email', 'like', 'perf-test-%').del()
}

/**
 * Assert that performance result meets thresholds
 * @param result - Performance result to check
 * @param testName - Name of the test for error messages
 */
export function assertPerformance(result: PerformanceResult, testName: string): void {
  const violationMessages = result.violations.join(', ')

  if (!result.passed) {
    throw new Error(
      `Performance test "${testName}" failed: ${violationMessages}. ` +
      `Response time: ${result.responseTime}ms`
    )
  }
}

interface ExplainNodeSummary {
  nodeTypes: string[]
  indexNames: string[]
}

interface ExplainPlanNode {
  'Node Type'?: string
  'Index Name'?: string
  Plans?: ExplainPlanNode[]
}

export interface IndexedPlanOptions {
  expectedIndexes?: string[]
  allowSequentialScan?: boolean
}

export function summarizeExplainPlan(explainPlan: unknown): ExplainNodeSummary {
  const summary: ExplainNodeSummary = {
    nodeTypes: [],
    indexNames: [],
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    if (!value || typeof value !== 'object') return

    const maybeNode = value as ExplainPlanNode & { Plan?: ExplainPlanNode }

    if (maybeNode.Plan) {
      visit(maybeNode.Plan)
      return
    }

    if (maybeNode['Node Type']) {
      summary.nodeTypes.push(maybeNode['Node Type'])
    }

    if (maybeNode['Index Name']) {
      summary.indexNames.push(maybeNode['Index Name'])
    }

    if (maybeNode.Plans) {
      visit(maybeNode.Plans)
    }
  }

  visit(explainPlan)

  return {
    nodeTypes: Array.from(new Set(summary.nodeTypes)),
    indexNames: Array.from(new Set(summary.indexNames)),
  }
}

export function assertIndexedPlan(
  explainPlan: unknown,
  options: IndexedPlanOptions = {},
): ExplainNodeSummary {
  const summary = summarizeExplainPlan(explainPlan)
  const sequentialScan = summary.nodeTypes.includes('Seq Scan')

  if (sequentialScan && !options.allowSequentialScan) {
    throw new Error(`EXPLAIN plan used Seq Scan; node types: ${summary.nodeTypes.join(', ')}`)
  }

  for (const expectedIndex of options.expectedIndexes ?? []) {
    if (!summary.indexNames.includes(expectedIndex)) {
      throw new Error(
        `EXPLAIN plan did not use expected index "${expectedIndex}". ` +
        `Indexes used: ${summary.indexNames.join(', ') || 'none'}`
      )
    }
  }

  return summary
}

export async function explainQueryPlan(
  db: Knex,
  sql: string,
  bindings: readonly Knex.RawBinding[] = [],
): Promise<unknown> {
  const result = await db.raw(`EXPLAIN (FORMAT JSON) ${sql}`, bindings)
  const firstRow = result.rows?.[0] ?? result[0]?.[0]
  return firstRow?.['QUERY PLAN'] ?? firstRow?.query_plan ?? firstRow
}

/**
 * Log performance metrics for monitoring
 * @param testName - Name of the test
 * @param result - Performance result
 */
export function logPerformanceMetrics(testName: string, result: PerformanceResult): void {
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'performance.smoke_test',
      test: testName,
      responseTime: result.responseTime,
      queryCount: result.queryCount,
      passed: result.passed,
      violations: result.violations,
      timestamp: new Date().toISOString()
    })
  )
}
