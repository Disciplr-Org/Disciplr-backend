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
  /** Indexes expected to appear in representative EXPLAIN plans */
  expectedIndexes?: readonly string[]
  /** Allow sequential scans for tiny aggregate queries where indexes are not useful */
  allowSequentialScan?: boolean
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

export interface EndpointPerformanceBudget extends PerformanceThresholds {
  /** Human-readable route or query shape covered by the budget */
  endpoint: string
  /** Query scenario covered by this budget */
  scenario: string
}

export interface QueryPlanAnalysis {
  nodeTypes: string[]
  usedIndexes: string[]
  sequentialScanTables: string[]
}

export const PERFORMANCE_BUDGETS = {
  'vaults.list': {
    endpoint: 'GET /api/vaults',
    scenario: 'first page with default ordering',
    maxResponseTime: 1200,
    maxQueryCount: 5,
    allowSequentialScan: true
  },
  'vaults.filteredByStatus': {
    endpoint: 'GET /api/vaults?status=active&sortBy=endTimestamp',
    scenario: 'status filter with deadline ordering',
    maxResponseTime: 1500,
    maxQueryCount: 6,
    expectedIndexes: ['idx_vaults_status_end_date']
  },
  'vaults.deepPage': {
    endpoint: 'GET /api/vaults?page=10&pageSize=50&sortBy=endTimestamp',
    scenario: 'deep offset page with deadline ordering',
    maxResponseTime: 2000,
    maxQueryCount: 6,
    expectedIndexes: ['idx_vaults_end_date']
  },
  'transactions.list': {
    endpoint: 'GET /api/transactions',
    scenario: 'first cursor page with newest ordering',
    maxResponseTime: 1200,
    maxQueryCount: 5,
    expectedIndexes: ['idx_transactions_stellar_timestamp']
  },
  'transactions.filteredByType': {
    endpoint: 'GET /api/transactions?type=deposit&sortBy=created_at',
    scenario: 'type filter with created-at ordering',
    maxResponseTime: 1500,
    maxQueryCount: 6,
    expectedIndexes: ['idx_transactions_type_created_at']
  },
  'transactions.byVault': {
    endpoint: 'GET /api/transactions/vault/:vaultId',
    scenario: 'vault-specific transaction list',
    maxResponseTime: 1200,
    maxQueryCount: 5,
    expectedIndexes: ['idx_transactions_vault_id']
  },
  'analytics.summary': {
    endpoint: 'GET /api/analytics/summary',
    scenario: 'aggregate summary',
    maxResponseTime: 750,
    maxQueryCount: 4,
    allowSequentialScan: true
  },
  'analytics.vaults': {
    endpoint: 'GET /api/analytics/vaults',
    scenario: 'vault analytics rollup',
    maxResponseTime: 1000,
    maxQueryCount: 5,
    allowSequentialScan: true
  },
  'analytics.milestoneTrends': {
    endpoint: 'GET /api/analytics/milestones/trends',
    scenario: 'date-range milestone trend query',
    maxResponseTime: 1500,
    maxQueryCount: 6,
    allowSequentialScan: true
  }
} as const satisfies Record<string, EndpointPerformanceBudget>

export type PerformanceBudgetName = keyof typeof PERFORMANCE_BUDGETS

export function getPerformanceBudget(name: PerformanceBudgetName): EndpointPerformanceBudget {
  return PERFORMANCE_BUDGETS[name]
}

export function evaluatePerformanceThresholds(
  responseTime: number,
  thresholds: PerformanceThresholds,
  queryCount?: number
): PerformanceResult {
  const violations: string[] = []

  if (responseTime > thresholds.maxResponseTime) {
    violations.push(
      `Response time ${responseTime}ms exceeded threshold ${thresholds.maxResponseTime}ms`
    )
  }

  if (queryCount !== undefined && thresholds.maxQueryCount !== undefined && queryCount > thresholds.maxQueryCount) {
    violations.push(
      `Query count ${queryCount} exceeded threshold ${thresholds.maxQueryCount}`
    )
  }

  return {
    responseTime,
    queryCount,
    passed: violations.length === 0,
    violations
  }
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

  return evaluatePerformanceThresholds(responseTime, thresholds)
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

export async function explainQueryPlan(
  db: Knex,
  sql: string,
  bindings: readonly unknown[] = []
): Promise<unknown> {
  const result = await db.raw(`EXPLAIN (FORMAT JSON) ${sql}`, bindings)
  return result.rows ?? result
}

export function analyseQueryPlan(plan: unknown): QueryPlanAnalysis {
  const analysis: QueryPlanAnalysis = {
    nodeTypes: [],
    usedIndexes: [],
    sequentialScanTables: []
  }

  visitPlanNode(plan, analysis)

  return {
    nodeTypes: unique(analysis.nodeTypes),
    usedIndexes: unique(analysis.usedIndexes),
    sequentialScanTables: unique(analysis.sequentialScanTables)
  }
}

export function assertIndexedQueryPlan(
  plan: unknown,
  thresholds: PerformanceThresholds,
  testName: string
): QueryPlanAnalysis {
  const analysis = analyseQueryPlan(plan)
  const violations: string[] = []

  if (!thresholds.allowSequentialScan && analysis.sequentialScanTables.length > 0) {
    violations.push(
      `Sequential scan detected on ${analysis.sequentialScanTables.join(', ')}`
    )
  }

  for (const expectedIndex of thresholds.expectedIndexes ?? []) {
    if (!analysis.usedIndexes.includes(expectedIndex)) {
      violations.push(`Expected index ${expectedIndex} was not used`)
    }
  }

  if (violations.length > 0) {
    throw new Error(`Performance query plan "${testName}" failed: ${violations.join(', ')}`)
  }

  return analysis
}

function visitPlanNode(plan: unknown, analysis: QueryPlanAnalysis): void {
  if (Array.isArray(plan)) {
    for (const item of plan) {
      visitPlanNode(item, analysis)
    }
    return
  }

  if (typeof plan === 'string') {
    visitTextPlan(plan, analysis)
    return
  }

  if (!plan || typeof plan !== 'object') {
    return
  }

  const node = plan as Record<string, unknown>
  const nodeType = stringValue(node['Node Type'])
  if (nodeType) {
    analysis.nodeTypes.push(nodeType)
  }

  const indexName = stringValue(node['Index Name'])
  if (indexName) {
    analysis.usedIndexes.push(indexName)
  }

  if (nodeType?.toLowerCase() === 'seq scan') {
    analysis.sequentialScanTables.push(stringValue(node['Relation Name']) ?? 'unknown')
  }

  visitPlanNode(node['QUERY PLAN'], analysis)
  visitPlanNode(node.Plan, analysis)
  visitPlanNode(node.Plans, analysis)
}

function visitTextPlan(plan: string, analysis: QueryPlanAnalysis): void {
  for (const line of plan.split(/\r?\n/)) {
    const seqScan = line.match(/\bSeq Scan on\s+([^\s]+)/i)
    if (seqScan) {
      analysis.nodeTypes.push('Seq Scan')
      analysis.sequentialScanTables.push(seqScan[1])
    }

    const indexScan = line.match(/\bIndex(?: Only)? Scan using\s+([^\s]+)/i)
    if (indexScan) {
      analysis.nodeTypes.push(line.includes('Index Only Scan') ? 'Index Only Scan' : 'Index Scan')
      analysis.usedIndexes.push(indexScan[1])
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
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
  if (!result.passed) {
    const violationMessages = result.violations.join(', ')
    throw new Error(
      `Performance test "${testName}" failed: ${violationMessages}. ` +
      `Response time: ${result.responseTime}ms`
    )
  }
}

export function assertQueryCount(
  queryCount: number,
  thresholds: PerformanceThresholds,
  testName: string
): void {
  const result = evaluatePerformanceThresholds(0, thresholds, queryCount)
  const queryViolations = result.violations.filter((violation) => violation.startsWith('Query count'))

  if (queryViolations.length > 0) {
    throw new Error(`Performance test "${testName}" failed: ${queryViolations.join(', ')}`)
  }
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
