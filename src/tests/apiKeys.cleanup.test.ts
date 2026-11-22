/**
 * Tests for cleanupExpiredRotationGrace and the 'apiKeys.cleanup' job handler.
 *
 * All tests run against the in-memory repository (getPgPool returns null) so
 * no real database is required.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import { ApiScope } from '../types/auth.js'

// ── Module mocks — must precede all dynamic imports ─────────────────────────

jest.unstable_mockModule('../db/pool.js', () => ({ getPgPool: () => null }))
jest.unstable_mockModule('../db/index.js', () => ({
  default: Object.assign(jest.fn(), { transaction: jest.fn() }),
}))

// Additional mocks required when handlers.ts is imported further down.
jest.unstable_mockModule('../services/session.js', () => ({
  cleanupExpiredSessions: jest.fn<() => Promise<number>>().mockResolvedValue(0),
}))
jest.unstable_mockModule('../services/notifications/factory.js', () => ({
  createNotificationService: jest.fn().mockReturnValue({ send: jest.fn() }),
  NotificationService: class {},
}))
jest.unstable_mockModule('../services/exportQueue.js', () => ({
  processJob: jest.fn().mockResolvedValue(undefined),
}))
jest.unstable_mockModule('../services/transactionETL.js', () => ({
  TransactionETLService: jest.fn().mockImplementation(() => ({
    reconcileVaults: jest.fn().mockResolvedValue({ checked: 0, totalVaults: 0, driftDetected: 0, missingOnChain: 0, errors: 0 }),
  })),
}))
jest.unstable_mockModule('../services/evidenceReindex.js', () => ({
  MilestoneEmbeddingSource: jest.fn(),
  ReindexCursorStore: jest.fn(),
  runReindexBatches: jest.fn().mockResolvedValue({ batches: 0, processed: 0, reindexed: 0, skippedUpToDate: 0, done: true }),
}))
jest.unstable_mockModule('../services/embeddingProvider.js', () => ({
  EmbeddingProvider: class {},
}))
jest.unstable_mockModule('../services/soroban.js', () => ({
  submitSlash: jest.fn().mockResolvedValue({ submission: { status: 'not_configured' } }),
}))
jest.unstable_mockModule('../services/settlementOperations.js', () => ({
  confirmSettlementOperation: jest.fn(),
  markSettlementSubmitted: jest.fn(),
  recordSettlementAttemptFailure: jest.fn().mockResolvedValue({ attemptCount: 1, failureCode: 'NETWORK_ERROR' }),
}))
jest.unstable_mockModule('../services/vaultExpiry.service.js', () => ({
  sendMilestoneReminders: jest.fn().mockResolvedValue(0),
  sendMilestoneDigestReminders: jest.fn().mockResolvedValue({ digestsSent: 0, digestsDeferred: 0, totalMilestones: 0 }),
  processDeferredReminders: jest.fn().mockResolvedValue(0),
}))
jest.unstable_mockModule('../services/retention.js', () => ({
  purgeSoftDeletedVaults: jest.fn().mockResolvedValue(0),
}))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
}))
jest.unstable_mockModule('../services/outboxRelay.js', () => ({
  relayOutboxBatch: jest.fn().mockResolvedValue(0),
}))
jest.unstable_mockModule('../services/analytics.service.js', () => ({
  renderOrgAnalyticsSnapshot: jest.fn().mockResolvedValue({}),
}))
jest.unstable_mockModule('../services/analyticsReports.js', () => ({
  saveOrgReport: jest.fn().mockResolvedValue(undefined),
  getAllOrgIds: jest.fn().mockResolvedValue([]),
  checkAndIncrementReportQuota: jest.fn().mockResolvedValue(true),
}))
jest.unstable_mockModule('../services/exportS3.js', () => ({
  resolveS3Config: jest.fn().mockReturnValue(null),
  uploadToS3: jest.fn().mockResolvedValue(undefined),
}))

// ── Lazy imports ─────────────────────────────────────────────────────────────

const { createApiKey, cleanupExpiredRotationGrace, resetApiKeysTable, setApiKeyRepositoryForTests } =
  await import('../services/apiKeys.js')

const { createDefaultJobHandlers } = await import('../jobs/handlers.js')

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Returns an ISO timestamp offset by `offsetMs` from now. */
const isoOffset = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

// ── Custom in-memory repository with previous-field support ─────────────────

type MemRecord = {
  id: string
  previousKeyHash: string | null | undefined
  previousValidUntil: string | null | undefined
  [key: string]: unknown
}

const buildTestRepo = (rows: MemRecord[]) => ({
  async create() {},
  async listForUser() { return [] },
  async listForOrg() { return [] },
  async getById() { return null },
  async update(r: any) { return r },
  async findByIdForUser() { return null },
  async findByHashPrefix() { return [] },
  async clearExpiredPrevious(now: string, limit: number) {
    let count = 0
    for (const row of rows) {
      if (count >= limit) break
      if (row.previousValidUntil && row.previousValidUntil < now) {
        row.previousKeyHash = null
        row.previousValidUntil = null
        count++
      }
    }
    return count
  },
  async reset() { rows.length = 0 },
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('cleanupExpiredRotationGrace', () => {
  beforeEach(async () => {
    setApiKeyRepositoryForTests(null)
    await resetApiKeysTable()
  })

  it('returns 0 when there are no rows with expired previous_valid_until', async () => {
    const rows: MemRecord[] = [
      { id: '1', previousKeyHash: 'abc', previousValidUntil: isoOffset(60_000) }, // future
    ]
    setApiKeyRepositoryForTests(buildTestRepo(rows) as any)
    const cleared = await cleanupExpiredRotationGrace()
    expect(cleared).toBe(0)
    expect(rows[0].previousKeyHash).toBe('abc')
  })

  it('clears rows whose previous_valid_until is in the past', async () => {
    const rows: MemRecord[] = [
      { id: '1', previousKeyHash: 'abc', previousValidUntil: isoOffset(-1_000) }, // expired
      { id: '2', previousKeyHash: 'def', previousValidUntil: isoOffset(60_000) },  // still valid
    ]
    setApiKeyRepositoryForTests(buildTestRepo(rows) as any)
    const cleared = await cleanupExpiredRotationGrace()
    expect(cleared).toBe(1)
    expect(rows[0].previousKeyHash).toBeNull()
    expect(rows[0].previousValidUntil).toBeNull()
    // Future row untouched
    expect(rows[1].previousKeyHash).toBe('def')
  })

  it('leaves rows with no previous_valid_until untouched', async () => {
    const rows: MemRecord[] = [
      { id: '1', previousKeyHash: null, previousValidUntil: null },
      { id: '2', previousKeyHash: undefined, previousValidUntil: undefined },
    ]
    setApiKeyRepositoryForTests(buildTestRepo(rows) as any)
    const cleared = await cleanupExpiredRotationGrace()
    expect(cleared).toBe(0)
  })

  it('respects the batch limit', async () => {
    const rows: MemRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      previousKeyHash: `hash${i}`,
      previousValidUntil: isoOffset(-1_000),
    }))
    setApiKeyRepositoryForTests(buildTestRepo(rows) as any)
    const cleared = await cleanupExpiredRotationGrace(3)
    expect(cleared).toBe(3)
    // Only first 3 rows were cleared
    const cleared3 = rows.slice(0, 3).filter((r) => r.previousKeyHash === null)
    const untouched2 = rows.slice(3).filter((r) => r.previousKeyHash !== null)
    expect(cleared3).toHaveLength(3)
    expect(untouched2).toHaveLength(2)
  })

  it('is idempotent: running twice returns 0 on second call', async () => {
    const rows: MemRecord[] = [
      { id: '1', previousKeyHash: 'abc', previousValidUntil: isoOffset(-1_000) },
    ]
    setApiKeyRepositoryForTests(buildTestRepo(rows) as any)
    await cleanupExpiredRotationGrace()
    const second = await cleanupExpiredRotationGrace()
    expect(second).toBe(0)
  })

  it('defaults to batchSize 1000', async () => {
    const clearExpiredPrevious = jest.fn<(now: string, limit: number) => Promise<number>>().mockResolvedValue(0)
    setApiKeyRepositoryForTests({
      create: jest.fn(),
      listForUser: jest.fn(),
      listForOrg: jest.fn(),
      getById: jest.fn(),
      update: jest.fn(),
      findByIdForUser: jest.fn(),
      findByHashPrefix: jest.fn(),
      clearExpiredPrevious,
      reset: jest.fn(),
    } as any)
    await cleanupExpiredRotationGrace()
    expect(clearExpiredPrevious).toHaveBeenCalledWith(expect.any(String), 1000)
  })
})

// ── Handler registration test ─────────────────────────────────────────────

describe("createDefaultJobHandlers — 'apiKeys.cleanup' registration", () => {
  it('is included in the handler map returned by createDefaultJobHandlers', () => {
    const handlers = createDefaultJobHandlers(
      { send: jest.fn() } as any,
      { source: {} as any, cursorStore: {} as any, embeddingProvider: {} as any },
    )

    expect(typeof handlers['apiKeys.cleanup']).toBe('function')
  })
})

