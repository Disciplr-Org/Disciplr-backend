import { jest, describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockKnexTrxChain: any = {
  insert: jest.fn().mockReturnThis(),
  onConflict: jest.fn().mockReturnThis(),
  ignore: jest.fn().mockResolvedValue(true),
  where: jest.fn().mockReturnThis(),
  forUpdate: jest.fn().mockReturnThis(),
  noWait: jest.fn().mockReturnThis(),
  first: jest.fn(),
  update: jest.fn().mockResolvedValue(true),
  commit: jest.fn().mockResolvedValue(true),
  rollback: jest.fn().mockResolvedValue(true),
}

const mockKnexTrx = jest.fn(() => mockKnexTrxChain)

const mockDbTransaction = jest.fn(async () => {
  return mockKnexTrx
})

// Add commit and rollback to the mocked transaction object
mockKnexTrx.commit = mockKnexTrxChain.commit
mockKnexTrx.rollback = mockKnexTrxChain.rollback

const mockKnexIndexChain: any = {
  transaction: mockDbTransaction,
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  onConflict: jest.fn().mockReturnThis(),
  merge: jest.fn().mockResolvedValue(true),
  select: jest.fn().mockReturnThis(),
  first: jest.fn(),
  then: jest.fn((resolve: any) => resolve([])),
  update: jest.fn().mockResolvedValue(1),
}
const mockKnexIndex = jest.fn(() => mockKnexIndexChain)
mockKnexIndex.transaction = mockDbTransaction

mock.module('../db/index.js', () => ({
  default: mockKnexIndex,
}))

// Mock jobs system
const mockJobSystem = {
  enqueue: jest.fn(),
  getMetrics: jest.fn().mockReturnValue({
    running: true,
    queueDepth: 0,
    activeJobs: 0,
    totals: { enqueued: 0, completed: 0, failed: 0 },
  }),
}

// Mock idempotency
mock.module('../services/idempotency.js', () => ({
  getIdempotentResponse: jest.fn().mockResolvedValue(null),
  saveIdempotentResponse: jest.fn().mockResolvedValue(undefined),
}))

// ─── Import subject ──────────────────────────────────────────────────────────

const { startExpirationChecker, stopExpirationChecker } = await import('../services/expirationScheduler.js')

// Helper to flush promises
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('expirationScheduler overlap guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    stopExpirationChecker()
    jest.useRealTimers()
  })

  it('acquires lock, performs work, and releases lock on success', async () => {
    mockKnexIndexChain.then.mockImplementation((resolve: any) => resolve([{ id: 'vault-1' }])) // expiredVaultsBatch
    mockKnexTrxChain.first.mockResolvedValue({ last_run_at: new Date() }) // heartbeat exists

    startExpirationChecker(60000, mockJobSystem as any)
    
    jest.advanceTimersByTime(1)
    await flushPromises()

    expect(mockDbTransaction).toHaveBeenCalled()
    expect(mockKnexTrxChain.forUpdate).toHaveBeenCalled()
    expect(mockKnexTrxChain.noWait).toHaveBeenCalled()
    
    // Lock released via commit
    expect(mockKnexTrxChain.commit).toHaveBeenCalled()
    expect(mockKnexTrxChain.rollback).not.toHaveBeenCalled()
  })

  it('skips run if overlap is detected (lock held)', async () => {
    // Simulate lock not available
    const lockError = new Error('lock not available')
    mockKnexTrxChain.first.mockRejectedValue(lockError)

    startExpirationChecker(60000, mockJobSystem as any)
    
    jest.advanceTimersByTime(1)
    await flushPromises()

    // Since lock failed, it rolls back and returns early
    expect(mockKnexTrxChain.rollback).toHaveBeenCalled()
    expect(mockKnexTrxChain.commit).not.toHaveBeenCalled()
    
    // Work should not have been performed
    expect(mockJobSystem.enqueue).not.toHaveBeenCalled()
  })

  it('detects and recovers missed run', async () => {
    // Gap of 3 minutes
    const oldDate = new Date(Date.now() - 3 * 60 * 1000)
    mockKnexTrxChain.first.mockResolvedValue({ last_run_at: oldDate })
    mockKnexIndexChain.then.mockImplementation((resolve: any) => resolve([]))

    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    startExpirationChecker(60000, mockJobSystem as any)
    
    jest.advanceTimersByTime(1)
    await flushPromises()

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Missed run detected and recovered'))
    expect(mockKnexTrxChain.commit).toHaveBeenCalled()
    
    consoleWarnSpy.mockRestore()
  })

  it('releases lock on error during work', async () => {
    mockKnexTrxChain.first.mockResolvedValue({ last_run_at: new Date() })
    // Simulate error during batch processing
    mockKnexIndexChain.then.mockImplementation(() => Promise.reject(new Error('DB Error')))

    startExpirationChecker(60000, mockJobSystem as any)
    
    jest.advanceTimersByTime(1)
    await flushPromises()

    expect(mockKnexTrxChain.rollback).toHaveBeenCalled()
    expect(mockKnexTrxChain.commit).not.toHaveBeenCalled()
  })
})
