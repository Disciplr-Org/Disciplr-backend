import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockKnexIndexChain: any = {
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  onConflict: jest.fn().mockReturnThis(),
  merge: jest.fn().mockResolvedValue(true),
  select: jest.fn().mockReturnThis(),
  first: jest.fn(),
  then: jest.fn((resolve: any) => resolve([])),
}
const mockKnexIndex = jest.fn(() => mockKnexIndexChain)

const mockKnexKnexChain: any = {
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  onConflict: jest.fn().mockReturnThis(),
  merge: jest.fn().mockResolvedValue(true),
  select: jest.fn().mockReturnThis(),
  first: jest.fn(),
  then: jest.fn((resolve: any) => resolve([])),
}
const mockKnexKnex = jest.fn(() => mockKnexKnexChain)

jest.unstable_mockModule('../db/index.js', () => ({
  default: mockKnexIndex,
  db: mockKnexIndex,
}))

jest.unstable_mockModule('../db/knex.js', () => ({
  db: mockKnexKnex,
}))

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: { $queryRaw: jest.fn<any>().mockResolvedValue([{ '?column?': 1 }]) },
}))

// Mock jobs system
const mockJobSystem = {
  getMetrics: jest.fn().mockReturnValue({
    running: true,
    queueDepth: 0,
    activeJobs: 0,
    totals: { enqueued: 0, completed: 0, failed: 0 },
  }),
}

// ─── Import subject ──────────────────────────────────────────────────────────

const { startExpirationChecker, stopExpirationChecker } = await import('./../services/expirationScheduler.js')
const { healthService } = await import('./../services/healthService.js')

// Helper to flush promises
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('expirationScheduler and healthService heartbeat integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    delete process.env.SCHEDULER_DEGRADED_THRESHOLD_MS
    delete process.env.SCHEDULER_DOWN_THRESHOLD_MS
  })

  afterEach(() => {
    stopExpirationChecker()
    jest.useRealTimers()
  })

  it('writes a heartbeat on startup/run', async () => {
    mockKnexIndexChain.then.mockImplementation((resolve: any) => resolve([]))
    startExpirationChecker(60000, mockJobSystem as any)
    
    // Allow runCheck to run through its async chain
    jest.advanceTimersByTime(1)
    await flushPromises()

    expect(mockKnexIndex).toHaveBeenCalledWith('scheduler_heartbeats')
    expect(mockKnexIndexChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'expiration_scheduler',
        last_run_at: expect.any(Date),
      })
    )
  })

  it('checkExpirationScheduler returns down when no heartbeat is present', async () => {
    mockKnexKnexChain.first.mockResolvedValue(undefined)
    const result = await healthService.checkExpirationScheduler()
    expect(result.status).toBe('down')
    expect(result.error).toMatch(/No heartbeat recorded/i)
  })

  it('checkExpirationScheduler returns up when heartbeat is fresh', async () => {
    mockKnexKnexChain.first.mockResolvedValue({
      last_run_at: new Date(),
    })
    const result = await healthService.checkExpirationScheduler()
    expect(result.status).toBe('up')
    expect(result.timeSinceLastRunMs).toBeLessThan(1000)
  })

  it('checkExpirationScheduler returns stale when heartbeat is stale but not down', async () => {
    // 4 minutes ago is between 3 mins degraded and 10 mins down
    mockKnexKnexChain.first.mockResolvedValue({
      last_run_at: new Date(Date.now() - 4 * 60 * 1000),
    })
    const result = await healthService.checkExpirationScheduler()
    expect(result.status).toBe('stale')
    expect(result.error).toMatch(/Heartbeat is stale/i)
  })

  it('checkExpirationScheduler returns down when heartbeat is extremely stale', async () => {
    // 11 minutes ago is > 10 mins down threshold
    mockKnexKnexChain.first.mockResolvedValue({
      last_run_at: new Date(Date.now() - 11 * 60 * 1000),
    })
    const result = await healthService.checkExpirationScheduler()
    expect(result.status).toBe('down')
    expect(result.error).toMatch(/Scheduler appears to be down/i)
  })

  it('buildDeepHealthStatus includes expirationScheduler status', async () => {
    mockKnexKnexChain.first.mockResolvedValue({
      last_run_at: new Date(),
    })
    const result = await healthService.buildDeepHealthStatus(mockJobSystem as any)
    expect(result.status).toBe('ok')
    expect(result.details.expirationScheduler).toBeDefined()
    expect(result.details.expirationScheduler.status).toBe('up')
  })
})
