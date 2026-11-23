/**
 * Tests for BackgroundJobSystem (src/jobs/system.ts): lifecycle (start, stop,
 * drain), recurring-job scheduling, the advisory-lock / overlap guard and the
 * scheduler heartbeat.
 *
 * Ported from an older suite written against a `SchedulerRegistry` that is no
 * longer exported. The scheduler is now an internal detail of
 * BackgroundJobSystem, so the same scenarios are driven through the public
 * API. Hermetic: no network, no Postgres; time is controlled with fake timers.
 *
 * Jest-ESM note: modules are mocked with jest.unstable_mockModule and the
 * module under test is imported dynamically afterwards.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// -- Mocks (registered before the dynamic import of the module under test) ----

type QueryResult = { rows: Array<{ acquired: boolean }> }

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>()
const mockRelease = jest.fn<() => void>()
const mockPool = {
  connect: jest.fn<() => Promise<{ query: typeof mockQuery; release: typeof mockRelease }>>(),
}
const mockGetPgPool = jest.fn<() => typeof mockPool | null>()

const mockMerge = jest.fn<(row: unknown) => Promise<void>>()
const mockOnConflict = jest.fn<(column: string) => { merge: typeof mockMerge }>()
const mockInsert = jest.fn<(row: unknown) => { onConflict: typeof mockOnConflict }>()
const mockDb = jest.fn<(table: string) => { insert: typeof mockInsert }>()

const mockListOrganizations = jest.fn<() => Promise<Array<{ id: string }>>>()
const mockRecoverPendingExportJobs = jest.fn<(system: unknown) => Promise<void>>()
const mockJobHandler = jest.fn<(payload: unknown, ctx: unknown) => Promise<void>>()

jest.unstable_mockModule('../db/index.js', () => ({ default: mockDb }))
jest.unstable_mockModule('../db/pool.js', () => ({ getPgPool: mockGetPgPool }))
jest.unstable_mockModule('../services/organization.js', () => ({
  listOrganizations: mockListOrganizations,
}))
jest.unstable_mockModule('../services/exportQueue.js', () => ({
  recoverPendingExportJobs: mockRecoverPendingExportJobs,
}))
jest.unstable_mockModule('../services/notifications/factory.js', () => ({
  createNotificationService: jest.fn(() => ({})),
}))
jest.unstable_mockModule('../repositories/milestoneRepository.js', () => ({
  MilestoneRepository: jest.fn(),
}))
jest.unstable_mockModule('../services/backfillCursorStore.js', () => ({
  BackfillCursorStore: jest.fn(),
}))
jest.unstable_mockModule('../services/embeddingProvider.js', () => ({
  createEmbeddingProvider: jest.fn(() => ({})),
}))
// Every registered job type gets the same spy handler so enqueued jobs run
// without touching real services.
jest.unstable_mockModule('./handlers.js', () => ({
  createDefaultJobHandlers: jest.fn(() => new Proxy({}, { get: () => mockJobHandler })),
}))

const { BackgroundJobSystem } = await import('./system.js')

// -- Helpers ------------------------------------------------------------------

const SCHEDULER_ENV = {
  // Short intervals for the jobs the tests observe; the rest keep their long
  // defaults so they never fire inside the windows advanced below.
  DEADLINE_CHECK_INTERVAL_MS: '1000',
  SAVED_SEARCH_EVAL_INTERVAL_MS: '1000',
  RETENTION_PURGE_INTERVAL_MS: '1000',
} as const

const ENV_KEYS = [...Object.keys(SCHEDULER_ENV), 'ENABLE_JOB_SCHEDULER']

let lockAcquired: boolean
let savedEnv: Record<string, string | undefined>
let systems: Array<InstanceType<typeof BackgroundJobSystem>>
let consoleLog: jest.SpiedFunction<typeof console.log>
let consoleError: jest.SpiedFunction<typeof console.error>

const createSystem = () => {
  const system = new BackgroundJobSystem({} as never, {} as never)
  systems.push(system)
  return system
}

/** Replace enqueue so scheduled executions are observable without running jobs. */
const spyOnEnqueue = (system: InstanceType<typeof BackgroundJobSystem>) =>
  jest.spyOn(system, 'enqueue').mockImplementation(((type: string) => ({
    id: `job-${type}`,
    type,
    runAt: new Date().toISOString(),
    maxAttempts: 1,
  })) as never)

const enqueuedTypes = (spy: ReturnType<typeof spyOnEnqueue>, type: string) =>
  spy.mock.calls.filter(([calledType]) => calledType === type)

const queries = (needle: string) =>
  mockQuery.mock.calls.filter(([sql]) => sql.includes(needle))

const heartbeatsFor = (name: string) =>
  mockInsert.mock.calls.filter(([row]) => (row as { name?: string }).name === name)

describe('BackgroundJobSystem', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    savedEnv = {}
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
    Object.assign(process.env, SCHEDULER_ENV)
    delete process.env.ENABLE_JOB_SCHEDULER

    systems = []
    lockAcquired = true

    mockQuery.mockImplementation(async (sql) => ({
      rows: sql.includes('pg_try_advisory_lock') ? [{ acquired: lockAcquired }] : [],
    }))
    mockPool.connect.mockResolvedValue({ query: mockQuery, release: mockRelease })
    mockGetPgPool.mockReturnValue(mockPool)

    mockMerge.mockResolvedValue(undefined)
    mockOnConflict.mockReturnValue({ merge: mockMerge })
    mockInsert.mockReturnValue({ onConflict: mockOnConflict })
    mockDb.mockReturnValue({ insert: mockInsert })

    mockListOrganizations.mockResolvedValue([])
    mockRecoverPendingExportJobs.mockResolvedValue(undefined)
    mockJobHandler.mockResolvedValue(undefined)

    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    for (const system of systems) {
      const stopping = system.stop()
      await jest.advanceTimersByTimeAsync(1000)
      await stopping
    }
    jest.useRealTimers()
    consoleLog.mockRestore()
    consoleError.mockRestore()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  describe('scheduling', () => {
    it('registers jobs and runs them on their interval', async () => {
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()

      // `deadline.check` is an immediate job: it runs once at start...
      await jest.advanceTimersByTimeAsync(0)
      expect(enqueuedTypes(enqueue, 'deadline.check')).toHaveLength(1)
      expect(enqueue).toHaveBeenCalledWith('deadline.check', { triggerSource: 'scheduler' })

      // ...and then once per interval.
      await jest.advanceTimersByTimeAsync(1000)
      expect(enqueuedTypes(enqueue, 'deadline.check')).toHaveLength(2)
      await jest.advanceTimersByTimeAsync(1000)
      expect(enqueuedTypes(enqueue, 'deadline.check')).toHaveLength(3)
    })

    it('runs non-immediate jobs only after their first interval', async () => {
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()
      await jest.advanceTimersByTimeAsync(999)
      expect(enqueuedTypes(enqueue, 'saved-search.evaluate')).toHaveLength(0)

      await jest.advanceTimersByTimeAsync(1)
      expect(enqueuedTypes(enqueue, 'saved-search.evaluate')).toHaveLength(1)
    })

    it('does not schedule recurring jobs when ENABLE_JOB_SCHEDULER is false', async () => {
      process.env.ENABLE_JOB_SCHEDULER = 'false'
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()
      await jest.advanceTimersByTimeAsync(5000)

      expect(enqueue).not.toHaveBeenCalled()
      expect(mockInsert).not.toHaveBeenCalled()
    })
  })

  describe('advisory lock and heartbeat', () => {
    it('acquires the lock, writes a heartbeat and releases the lock after a successful run', async () => {
      const system = createSystem()
      spyOnEnqueue(system)

      system.start()
      await jest.advanceTimersByTimeAsync(1000)

      expect(queries('pg_try_advisory_lock').length).toBeGreaterThan(0)
      expect(mockDb).toHaveBeenCalledWith('scheduler_heartbeats')
      expect(heartbeatsFor('deadline.check')[0]?.[0]).toEqual({
        name: 'deadline.check',
        last_run_at: expect.any(Date),
      })
      expect(mockOnConflict).toHaveBeenCalledWith('name')
      expect(mockMerge).toHaveBeenCalledWith({ last_run_at: expect.any(Date) })
      expect(queries('pg_advisory_unlock').length).toBeGreaterThan(0)
    })

    it('skips the job when the advisory lock is held by another replica', async () => {
      lockAcquired = false
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()
      await jest.advanceTimersByTimeAsync(1000)

      expect(enqueuedTypes(enqueue, 'deadline.check')).toHaveLength(0)
      expect(heartbeatsFor('deadline.check')).toHaveLength(0)
      expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Could not acquire lock'))
    })

    it('runs without an advisory lock when no Postgres pool is configured', async () => {
      mockGetPgPool.mockReturnValue(null)
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()
      await jest.advanceTimersByTimeAsync(1000)

      expect(enqueuedTypes(enqueue, 'deadline.check').length).toBeGreaterThan(0)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('releases the lock and skips the heartbeat when the job throws', async () => {
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)
      enqueue.mockImplementation(((type: string) => {
        if (type === 'deadline.check') throw new Error('boom')
        return { id: 'job', type, runAt: new Date().toISOString(), maxAttempts: 1 }
      }) as never)

      system.start()
      await jest.advanceTimersByTimeAsync(1000)

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Job deadline.check failed'),
        expect.objectContaining({ message: 'boom' }),
      )
      expect(heartbeatsFor('deadline.check')).toHaveLength(0)
      expect(queries('pg_advisory_unlock').length).toBeGreaterThan(0)
    })

    it('prevents concurrent execution of the same job locally', async () => {
      let finish!: () => void
      mockListOrganizations.mockImplementation(
        () => new Promise<Array<{ id: string }>>((resolve) => {
          finish = () => resolve([])
        }),
      )
      const system = createSystem()
      spyOnEnqueue(system)

      system.start()

      // First retention.purge run starts and stays pending.
      await jest.advanceTimersByTimeAsync(1000)
      expect(mockListOrganizations).toHaveBeenCalledTimes(1)

      // The next tick overlaps the pending run and is skipped.
      await jest.advanceTimersByTimeAsync(1000)
      expect(mockListOrganizations).toHaveBeenCalledTimes(1)
      expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('already running locally'))
      expect(heartbeatsFor('retention.purge')).toHaveLength(0)

      // Once the pending run finishes, its heartbeat is written and the
      // following tick is allowed to run again.
      finish()
      await jest.advanceTimersByTimeAsync(0)
      expect(heartbeatsFor('retention.purge')).toHaveLength(1)

      await jest.advanceTimersByTimeAsync(1000)
      expect(mockListOrganizations).toHaveBeenCalledTimes(2)
    })
  })

  describe('lifecycle', () => {
    it('start is idempotent and does not double-schedule jobs', async () => {
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()
      system.start()
      await jest.advanceTimersByTimeAsync(1000)

      expect(enqueuedTypes(enqueue, 'saved-search.evaluate')).toHaveLength(1)
      expect(mockRecoverPendingExportJobs).toHaveBeenCalledTimes(1)
    })

    it('stop clears the recurring timers', async () => {
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()
      const stopping = system.stop()
      await jest.advanceTimersByTimeAsync(5000)
      await stopping

      expect(enqueuedTypes(enqueue, 'saved-search.evaluate')).toHaveLength(0)
    })

    it('rejects enqueue after stop', async () => {
      const system = createSystem()
      system.start()
      const stopping = system.stop()
      await jest.advanceTimersByTimeAsync(100)
      await stopping

      expect(() => system.enqueue('sessions.cleanup', {})).toThrow('shutting down')
    })

    it('can be restarted after stop', async () => {
      const system = createSystem()
      const enqueue = spyOnEnqueue(system)

      system.start()
      const stopping = system.stop()
      await jest.advanceTimersByTimeAsync(100)
      await stopping

      // enqueue was spied, so restart behaviour is observable through scheduling.
      system.start()
      await jest.advanceTimersByTimeAsync(1000)
      expect(enqueuedTypes(enqueue, 'saved-search.evaluate').length).toBeGreaterThan(0)
    })

    it('rejects unregistered job types and exposes the registered ones', () => {
      const system = createSystem()

      expect(system.getRegisteredJobTypes()).toContain('deadline.check')
      expect(() => system.enqueue('not.a.job' as never, {} as never)).toThrow(TypeError)
    })

    it('runs enqueued jobs while started and drains in-flight work on stop', async () => {
      let finish!: () => void
      mockJobHandler.mockImplementation(
        () => new Promise<void>((resolve) => {
          finish = resolve
        }),
      )
      process.env.ENABLE_JOB_SCHEDULER = 'false'
      const system = createSystem()

      system.start()
      system.enqueue('sessions.cleanup', {})
      await jest.advanceTimersByTimeAsync(250)
      expect(mockJobHandler).toHaveBeenCalledTimes(1)

      // stop() waits for the in-flight job instead of dropping it.
      let stopped = false
      const stopping = system.stop().then(() => {
        stopped = true
      })
      await jest.advanceTimersByTimeAsync(100)
      expect(stopped).toBe(false)

      finish()
      await jest.advanceTimersByTimeAsync(100)
      await stopping
      expect(stopped).toBe(true)
      expect(system.getMetrics().totals.executions).toBe(1)
    })
  })
})
