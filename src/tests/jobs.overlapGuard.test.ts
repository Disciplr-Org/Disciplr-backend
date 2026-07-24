import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockKnexChain: any = {
  insert: jest.fn().mockReturnThis(),
  onConflict: jest.fn().mockReturnThis(),
  merge: jest.fn().mockResolvedValue(true),
}

const mockKnex = jest.fn(() => mockKnexChain)

jest.unstable_mockModule('../db/index.js', () => ({
  default: mockKnex,
  db: mockKnex,
}))

const mockClient: any = {
  query: jest.fn(),
  release: jest.fn(),
}

const mockPool: any = {
  connect: jest.fn().mockResolvedValue(mockClient),
}

jest.unstable_mockModule('../db/pool.js', () => ({
  getPgPool: jest.fn().mockReturnValue(mockPool),
}))

// ─── Import subject ──────────────────────────────────────────────────────────

const { BackgroundJobSystem } = await import('../jobs/system.js')
const { getPgPool } = await import('../db/pool.js')

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('Scheduler Overlap Guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('acquires advisory lock and executes job when lock is available', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true } }) // lock acquire
      .mockResolvedValueOnce({ rows: [] }) // lock release

    let jobExecuted = false
    const system = new BackgroundJobSystem()

    // @ts-ignore - accessing private scheduler registry
    system.schedulerRegistry.registerJob({
      name: 'test.job',
      intervalMs: 60000,
      immediate: true,
      execute: () => {
        jobExecuted = true
      },
    })

    system.start()
    jest.advanceTimersByTime(1)
    await flushPromises()
    system.stop()

    expect(jobExecuted).toBe(true)
    expect(mockPool.connect).toHaveBeenCalledTimes(2) // acquire + release
    expect(mockClient.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1, $2) as acquired',
      expect.any(Array)
    )
    expect(mockKnex).toHaveBeenCalledWith('scheduler_heartbeats')
    expect(mockKnexChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test.job',
        last_run_at: expect.any(Date),
      })
    )
  })

  it('skips job when lock is not available', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: false } })

    let jobExecuted = false
    const system = new BackgroundJobSystem()

    // @ts-ignore
    system.schedulerRegistry.registerJob({
      name: 'test.job',
      intervalMs: 60000,
      immediate: true,
      execute: () => {
        jobExecuted = true
      },
    })

    system.start()
    jest.advanceTimersByTime(1)
    await flushPromises()
    system.stop()

    expect(jobExecuted).toBe(false)
  })

  it('skips job when already running locally', async () => {
    let jobExecutions = 0
    let jobStarted = false

    const system = new BackgroundJobSystem()

    // @ts-ignore
    system.schedulerRegistry.registerJob({
      name: 'test.job',
      intervalMs: 60000,
      immediate: true,
      execute: async () => {
        jobExecutions++
        if (!jobStarted) {
          jobStarted = true
          // Run again immediately to test local overlap check
          // @ts-ignore
          await system.schedulerRegistry.runJobWithOverlapGuard({
            name: 'test.job',
            intervalMs: 60000,
            execute: () => {},
          })
        }
      },
    })

    system.start()
    jest.advanceTimersByTime(1)
    await flushPromises()
    system.stop()

    expect(jobExecutions).toBe(1)
  })

  it('still executes jobs independently', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })  // lock acquire job1
      .mockResolvedValueOnce({ rows: [] })  // lock release job1
      .mockResolvedValueOnce({ rows: [{ acquired: true }])  // lock acquire job2
      .mockResolvedValueOnce({ rows: [] })  // lock release job2

    let job1Executed = false
    let job2Executed = false
    const system = new BackgroundJobSystem()

    // @ts-ignore
    system.schedulerRegistry.registerJob({
      name: 'job1',
      intervalMs: 60000,
      immediate: true,
      execute: () => {
        job1Executed = true
      },
    })

    // @ts-ignore
    system.schedulerRegistry.registerJob({
      name: 'job2',
      intervalMs: 60000,
      immediate: true,
      execute: () => {
        job2Executed = true
      },
    })

    system.start()
    jest.advanceTimersByTime(1)
    await flushPromises()
    system.stop()

    expect(job1Executed).toBe(true)
    expect(job2Executed).toBe(true)
  })

  it('handles case when pg pool is not available', async () => {
    (getPgPool as jest.Mock).mockReturnValueOnce(null)

    let jobExecuted = false
    const system = new BackgroundJobSystem()

    // @ts-ignore
    system.schedulerRegistry.registerJob({
      name: 'test.job',
      intervalMs: 60000,
      immediate: true,
      execute: () => {
        jobExecuted = true
      },
    })

    system.start()
    jest.advanceTimersByTime(1)
    await flushPromises()
    system.stop()

    expect(jobExecuted).toBe(true)
  })
})
