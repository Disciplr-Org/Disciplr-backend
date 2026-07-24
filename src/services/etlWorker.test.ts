/**
 * ETLWorker graceful-shutdown + batch-ID tests.
 *
 * Uses dependency injection (the optional third constructor argument) to avoid
 * jest.mock() hoisting, which is not supported in ts-jest ESM mode.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { ETLWorker, type ETLWorkerOptions } from './etlWorker.js'
import type { TransactionETLService } from './transactionETL.js'
import type { ETLBatchResult, ETLConfig } from '../types/transactions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: ETLConfig = {
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  batchSize: 10,
  maxRetries: 3,
}

const COMPLETED_RESULT: ETLBatchResult = {
  batchId: 'test-batch-id',
  status: 'completed',
  operationsFetched: 5,
  transactionsInserted: 3,
  transactionsSkipped: 2,
  durationMs: 100,
}

/** Flush microtask queue enough times to settle a .catch().finally() chain. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

interface WorkerFixture {
  worker: ETLWorker
  mockRunETL: ReturnType<typeof jest.fn>
}

function makeWorker(opts: ETLWorkerOptions = {}): WorkerFixture {
  const mockRunETL = jest
    .fn<() => Promise<ETLBatchResult>>()
    .mockResolvedValue(COMPLETED_RESULT)
  const mockService = { runETL: mockRunETL } as unknown as TransactionETLService
  const worker = new ETLWorker(TEST_CONFIG, { drainTimeoutMs: 200, ...opts }, mockService)
  return { worker, mockRunETL }
}

// ---------------------------------------------------------------------------

describe('ETLWorker', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  // -------------------------------------------------------------------------
  describe('start()', () => {
    it('triggers an immediate ETL run', async () => {
      const { worker, mockRunETL } = makeWorker()
      worker.start()
      await flushMicrotasks()

      expect(mockRunETL).toHaveBeenCalledTimes(1)
      await worker.stop()
    })

    it('passes an AbortSignal and a batchId to the ETL service', async () => {
      const { worker, mockRunETL } = makeWorker()
      worker.start()
      await flushMicrotasks()

      expect(mockRunETL).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        expect.stringMatching(/^[0-9a-f-]{36}$/), // UUID
      )
      await worker.stop()
    })

    it('is a no-op when already running', async () => {
      const { worker, mockRunETL } = makeWorker()
      worker.start()
      worker.start()
      await flushMicrotasks()

      expect(mockRunETL).toHaveBeenCalledTimes(1)
      await worker.stop()
    })

    it('schedules periodic runs at the given interval', async () => {
      jest.useFakeTimers()
      const { worker, mockRunETL } = makeWorker()
      worker.start(1) // 1-minute interval

      await flushMicrotasks()
      expect(mockRunETL).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(60_000)
      await flushMicrotasks()
      expect(mockRunETL).toHaveBeenCalledTimes(2)

      jest.advanceTimersByTime(60_000)
      await flushMicrotasks()
      expect(mockRunETL).toHaveBeenCalledTimes(3)

      await worker.stop()
    })

    it('uses a different batchId for each tick', async () => {
      jest.useFakeTimers()
      const batchIds: string[] = []
      const mockRunETL = jest.fn<(signal: AbortSignal, batchId: string) => Promise<ETLBatchResult>>().mockImplementation(
        (_signal: AbortSignal, batchId: string) => {
          batchIds.push(batchId)
          return Promise.resolve(COMPLETED_RESULT)
        },
      )
      const mockService = { runETL: mockRunETL } as unknown as TransactionETLService
      const worker = new ETLWorker(TEST_CONFIG, { drainTimeoutMs: 200 }, mockService)

      worker.start(1)
      await flushMicrotasks()

      jest.advanceTimersByTime(60_000)
      await flushMicrotasks()

      expect(batchIds.length).toBe(2)
      expect(batchIds[0]).not.toBe(batchIds[1])

      await worker.stop()
    })
  })

  // -------------------------------------------------------------------------
  describe('stop()', () => {
    it('resolves immediately when the worker was never started', async () => {
      const { worker } = makeWorker()
      await expect(worker.stop()).resolves.toBeUndefined()
    })

    it('is idempotent – a second call resolves immediately', async () => {
      const { worker } = makeWorker()
      worker.start()
      await worker.stop()
      await expect(worker.stop()).resolves.toBeUndefined()
    })

    it('clears the interval so no further runs are scheduled', async () => {
      jest.useFakeTimers()
      const { worker, mockRunETL } = makeWorker()
      worker.start(1)

      await flushMicrotasks()
      await worker.stop()

      jest.advanceTimersByTime(120_000)
      await flushMicrotasks()

      expect(mockRunETL).toHaveBeenCalledTimes(1)
    })

    it('waits for the in-flight run to complete before resolving', async () => {
      let resolveRun!: () => void
      const { worker, mockRunETL } = makeWorker()
      mockRunETL.mockImplementationOnce(
        () => new Promise<ETLBatchResult>((resolve) => {
          resolveRun = () => resolve(COMPLETED_RESULT)
        }),
      )

      worker.start()

      let stopped = false
      const stopPromise = worker.stop().then(() => { stopped = true })

      await Promise.resolve()
      expect(stopped).toBe(false)

      resolveRun()
      await stopPromise

      expect(stopped).toBe(true)
    })

    it('proceeds after drainTimeoutMs if the run does not finish in time', async () => {
      const { worker, mockRunETL } = makeWorker({ drainTimeoutMs: 60 })
      mockRunETL.mockImplementationOnce(() => new Promise<ETLBatchResult>(() => {}))

      worker.start()

      const t0 = Date.now()
      await worker.stop()

      expect(Date.now() - t0).toBeGreaterThanOrEqual(60)
      expect(Date.now() - t0).toBeLessThan(1_000)
    })

    it('does not start new runs once stop has been called', async () => {
      let resolveRun!: () => void
      const { worker, mockRunETL } = makeWorker()
      mockRunETL.mockImplementationOnce(
        () => new Promise<ETLBatchResult>((resolve) => {
          resolveRun = () => resolve(COMPLETED_RESULT)
        }),
      )

      worker.start()
      const stopPromise = worker.stop()
      resolveRun()
      await stopPromise

      const callsAfterStop = mockRunETL.mock.calls.length
      await flushMicrotasks()
      expect(mockRunETL.mock.calls.length).toBe(callsAfterStop)
    })

    it('sets isRunning and hasInterval to false', async () => {
      const { worker } = makeWorker()
      worker.start()
      await worker.stop()

      const { isRunning, hasInterval } = worker.getStatus()
      expect(isRunning).toBe(false)
      expect(hasInterval).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  describe('runETL()', () => {
    it('is a no-op when the worker is not running', async () => {
      const { worker, mockRunETL } = makeWorker()
      await worker.runETL()
      expect(mockRunETL).not.toHaveBeenCalled()
    })

    it('triggers and awaits a run when the worker is running', async () => {
      const { worker, mockRunETL } = makeWorker()
      worker.start()
      await flushMicrotasks()

      await worker.runETL()
      expect(mockRunETL).toHaveBeenCalledTimes(2)

      await worker.stop()
    })

    it('skips if a run is already active', async () => {
      let resolveRun!: () => void
      const { worker, mockRunETL } = makeWorker()
      mockRunETL.mockImplementationOnce(
        () => new Promise<ETLBatchResult>((resolve) => {
          resolveRun = () => resolve(COMPLETED_RESULT)
        }),
      )

      worker.start()
      await worker.runETL()
      expect(mockRunETL).toHaveBeenCalledTimes(1)

      resolveRun()
      await worker.stop()
    })
  })

  // -------------------------------------------------------------------------
  describe('getStatus()', () => {
    it('returns the initial stopped state', () => {
      const { worker } = makeWorker()
      expect(worker.getStatus()).toEqual({
        isRunning: false,
        hasInterval: false,
        hasActiveRun: false,
      })
    })

    it('reflects running state after start()', () => {
      const { worker } = makeWorker()
      worker.start()

      const { isRunning, hasInterval } = worker.getStatus()
      expect(isRunning).toBe(true)
      expect(hasInterval).toBe(true)

      return worker.stop()
    })

    it('returns full stopped state after stop()', async () => {
      const { worker } = makeWorker()
      worker.start()
      await worker.stop()

      expect(worker.getStatus()).toEqual({
        isRunning: false,
        hasInterval: false,
        hasActiveRun: false,
      })
    })

    it('shows hasActiveRun=true while a run is executing', async () => {
      let resolveRun!: () => void
      const { worker, mockRunETL } = makeWorker()
      mockRunETL.mockImplementationOnce(
        () => new Promise<ETLBatchResult>((resolve) => {
          resolveRun = () => resolve(COMPLETED_RESULT)
        }),
      )

      worker.start()
      expect(worker.getStatus().hasActiveRun).toBe(true)

      resolveRun()
      await flushMicrotasks()
      expect(worker.getStatus().hasActiveRun).toBe(false)

      await worker.stop()
    })
  })

  // -------------------------------------------------------------------------
  describe('AbortSignal', () => {
    it('aborts the in-flight signal when stop() is called', async () => {
      let capturedSignal!: AbortSignal
      const { worker, mockRunETL } = makeWorker({ drainTimeoutMs: 60 })
      mockRunETL.mockImplementationOnce((signal: unknown) => {
        capturedSignal = signal as AbortSignal
        return new Promise<ETLBatchResult>(() => {})
      })

      worker.start()
      await worker.stop()

      expect(capturedSignal.aborted).toBe(true)
    })

    it('generates a fresh AbortController for each run', async () => {
      const signals: AbortSignal[] = []
      const { worker, mockRunETL } = makeWorker()
      mockRunETL.mockImplementation((signal: unknown) => {
        signals.push(signal as AbortSignal)
        return Promise.resolve(COMPLETED_RESULT)
      })

      worker.start()
      await flushMicrotasks()
      await worker.runETL()

      expect(signals.length).toBeGreaterThanOrEqual(2)
      expect(signals[0]).not.toBe(signals[1])

      await worker.stop()
    })

    it('does not abort the signal for a run that completes normally', async () => {
      let capturedSignal!: AbortSignal
      const { worker, mockRunETL } = makeWorker()
      mockRunETL.mockImplementationOnce((signal: unknown) => {
        capturedSignal = signal as AbortSignal
        return Promise.resolve(COMPLETED_RESULT)
      })

      worker.start()
      await flushMicrotasks()

      expect(capturedSignal.aborted).toBe(false)
      await worker.stop()
    })
  })
})
