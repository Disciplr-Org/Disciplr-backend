/**
 * deadlineSlash.test.ts
 *
 * Tests covering the full deadline → slash_on_miss pipeline:
 *   expirationScheduler → jobSystem.enqueue (with idempotency)
 *   deadline.check handler → buildSlashOnMissPayload
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import { resetIdempotencyStore } from '../services/idempotency.js'

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockEnqueue = jest.fn<any>()

// Mock BackgroundJobSystem so the scheduler never touches the real queue
jest.unstable_mockModule('../jobs/system.js', () => ({
  BackgroundJobSystem: jest.fn<any>().mockImplementation(() => ({
    enqueue: mockEnqueue,
    start: jest.fn<any>(),
    stop: jest.fn<any>(),
  })),
}))

// db mock – returns whatever expiredVaults is set to each test
let expiredVaults: Array<{ id: string }> = []

const mockDbChain = {
  where: jest.fn<any>(),
  limit: jest.fn<any>(),
  update: jest.fn<any>(),
}
mockDbChain.where.mockReturnValue(mockDbChain)
mockDbChain.limit.mockImplementation(async () => expiredVaults)
mockDbChain.update.mockResolvedValue(1)

jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn<any>().mockReturnValue(mockDbChain),
}))

// Mock markVaultExpiries used in the handler
jest.unstable_mockModule('../services/vault.js', () => ({
  markVaultExpiries: jest.fn<any>().mockResolvedValue(0),
}))

// Mock buildSlashOnMissPayload so handler tests can assert on it
const mockBuildSlashOnMissPayload = jest.fn<any>().mockImplementation((vaultId: string) => ({
  mode: 'submit' as const,
  payload: {
    contractId: 'CONTRACT_ID_NOT_CONFIGURED',
    networkPassphrase: 'Test SDF Network ; September 2015',
    sourceAccount: 'SOURCE_ACCOUNT_NOT_CONFIGURED',
    method: 'slash_on_miss',
    args: { vaultId },
  },
  submission: { attempted: true, status: 'not_configured' as const },
}))

jest.unstable_mockModule('../services/soroban.js', () => ({
  buildSlashOnMissPayload: mockBuildSlashOnMissPayload,
  buildVaultCreationPayload: jest.fn<any>(),
  getSorobanConfig: jest.fn<any>().mockReturnValue(null),
  isSorobanSubmitEnabled: jest.fn<any>().mockReturnValue(false),
}))

// ─── Dynamically import after mocks are set up ────────────────────────────────

const { startExpirationChecker, stopExpirationChecker } = await import(
  '../services/expirationScheduler.js'
)
const { defaultJobHandlers } = await import('../jobs/handlers.js')

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Deadline → slash_on_miss pipeline', () => {
  beforeEach(() => {
    resetIdempotencyStore()
    mockEnqueue.mockReset()
    mockBuildSlashOnMissPayload.mockClear()
    expiredVaults = []
    delete process.env.DRY_RUN
  })

  afterEach(() => {
    stopExpirationChecker()
    delete process.env.DRY_RUN
  })

  // ── Scheduler tests ──────────────────────────────────────────────────────

  it('1. enqueues deadline.check when checkExpiredVaults returns a vaultId', async () => {
    expiredVaults = [{ id: 'vault-abc' }]

    // Provide an injectable mock job system
    const { BackgroundJobSystem } = await import('../jobs/system.js')
    const jobSystem = new (BackgroundJobSystem as any)()

    startExpirationChecker(60_000, jobSystem)

    // Give the async runCheck() time to complete
    await new Promise((r) => setTimeout(r, 50))

    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).toHaveBeenCalledWith(
      'deadline.check',
      expect.objectContaining({ vaultId: 'vault-abc' }),
      expect.objectContaining({ maxAttempts: 3 }),
    )
  })

  it('2. does NOT call enqueue when checkExpiredVaults returns empty array', async () => {
    expiredVaults = []

    const { BackgroundJobSystem } = await import('../jobs/system.js')
    const jobSystem = new (BackgroundJobSystem as any)()

    startExpirationChecker(60_000, jobSystem)
    await new Promise((r) => setTimeout(r, 50))

    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('3. calling the scheduler twice with same vaultId only enqueues ONCE (idempotency)', async () => {
    expiredVaults = [{ id: 'vault-dup' }]

    const { BackgroundJobSystem } = await import('../jobs/system.js')
    const jobSystem = new (BackgroundJobSystem as any)()

    // First run
    startExpirationChecker(60_000, jobSystem)
    await new Promise((r) => setTimeout(r, 50))
    stopExpirationChecker()

    // Reset interval so we can start again; idempotency store is NOT cleared
    const enqueueCalls = mockEnqueue.mock.calls.length
    expect(enqueueCalls).toBe(1)

    // Second run with the same vaultId — idempotency key already exists
    startExpirationChecker(60_000, jobSystem)
    await new Promise((r) => setTimeout(r, 50))

    // Still only 1 total call
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it('4. DRY_RUN=true skips enqueue but logs instead', async () => {
    process.env.DRY_RUN = 'true'
    expiredVaults = [{ id: 'vault-dry' }]
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    const { BackgroundJobSystem } = await import('../jobs/system.js')
    const jobSystem = new (BackgroundJobSystem as any)()

    startExpirationChecker(60_000, jobSystem)
    await new Promise((r) => setTimeout(r, 50))

    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('DRY_RUN: skipping enqueue for vault vault-dry'),
    )
    consoleSpy.mockRestore()
  })

  // ── Handler tests ────────────────────────────────────────────────────────

  it('5. deadline.check handler calls buildSlashOnMissPayload with correct vaultId', async () => {
    const handler = defaultJobHandlers['deadline.check']
    await handler(
      { vaultId: 'vault-handler-test', triggerSource: 'expiration-scheduler' },
      { jobId: 'job-1', attempt: 1 },
    )

    expect(mockBuildSlashOnMissPayload).toHaveBeenCalledTimes(1)
    expect(mockBuildSlashOnMissPayload).toHaveBeenCalledWith('vault-handler-test')
  })

  it('6. deadline.check handler with no vaultId does NOT call buildSlashOnMissPayload', async () => {
    const handler = defaultJobHandlers['deadline.check']
    await handler(
      { triggerSource: 'scheduler' },
      { jobId: 'job-2', attempt: 1 },
    )

    expect(mockBuildSlashOnMissPayload).not.toHaveBeenCalled()
  })
})
