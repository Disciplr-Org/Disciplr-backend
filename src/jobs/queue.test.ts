import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { InMemoryJobQueue } from './queue.js'

const pause = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))

describe('InMemoryJobQueue', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  describe('enqueue', () => {
    it('returns a receipt with normalized delay and attempt values', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const queue = new InMemoryJobQueue()
      queue.registerHandler('oracle.call', async () => {})

      const receipt = queue.enqueue(
        'oracle.call',
        { oracle: 'test', symbol: 'XLM' },
        { delayMs: 10.9, maxAttempts: 3 },
      )

      expect(receipt).toEqual({
        id: expect.any(String),
        type: 'oracle.call',
        runAt: '2026-01-01T00:00:00.010Z',
        maxAttempts: 3,
      })
    })

    it('uses safe defaults for invalid numeric options', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const queue = new InMemoryJobQueue()
      queue.registerHandler('notification.send', async () => {})

      const receipt = queue.enqueue(
        'notification.send',
        { recipient: 'user@example.com', subject: 'Hello', body: 'Body' },
        { delayMs: -1, maxAttempts: Number.NaN },
      )

      expect(receipt.maxAttempts).toBe(3)
      expect(receipt.runAt).toBe('2026-01-01T00:00:00.000Z')
    })

    it('returns the existing receipt for a duplicate idempotency key', () => {
      const queue = new InMemoryJobQueue()
      queue.registerHandler('sessions.cleanup', async () => {})

      const first = queue.enqueue('sessions.cleanup', {}, { idempotencyKey: 'cleanup-1' })
      const duplicate = queue.enqueue('sessions.cleanup', {}, { idempotencyKey: 'cleanup-1' })

      expect(duplicate).toEqual(first)
      expect(queue.getMetrics().totals.enqueued).toBe(1)
    })
  })

  describe('execution and retry behavior', () => {
    it('runs a registered handler and records completion', async () => {
      const queue = new InMemoryJobQueue({ pollIntervalMs: 5 })
      const handler = jest.fn(async () => {})
      queue.registerHandler('oracle.call', handler)

      queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XLM' }, { maxAttempts: 1 })
      queue.start()
      await pause(30)
      await queue.stop()

      expect(handler).toHaveBeenCalledTimes(1)
      expect(queue.getMetrics().totals).toMatchObject({
        enqueued: 1,
        executions: 1,
        completed: 1,
        failed: 0,
      })
      expect(queue.getDeadLetters()).toHaveLength(0)
    })

    it('retries a transient failure after the supported backoff', async () => {
      jest.useFakeTimers()
      const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
      let attempts = 0
      queue.registerHandler('oracle.call', async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient failure')
      })

      queue.enqueue('oracle.call', { oracle: 'test', symbol: 'RETRY' }, { maxAttempts: 2 })
      queue.start()
      await jest.advanceTimersByTimeAsync(10)
      expect(attempts).toBe(1)

      await jest.advanceTimersByTimeAsync(1_000)
      await jest.advanceTimersByTimeAsync(10)
      expect(attempts).toBe(2)
      expect(queue.getMetrics().totals).toMatchObject({ completed: 1, retried: 1 })
      await queue.stop()
    })

    it('moves an exhausted failure to the dead-letter queue', async () => {
      const queue = new InMemoryJobQueue({ pollIntervalMs: 5 })
      queue.registerHandler('oracle.call', async () => {
        throw new Error('permanent failure')
      })

      queue.enqueue('oracle.call', { oracle: 'test', symbol: 'FAIL' }, { maxAttempts: 1 })
      queue.start()
      await pause(30)
      await queue.stop()

      const [deadLetter] = queue.getDeadLetters()
      expect(deadLetter).toMatchObject({
        type: 'oracle.call',
        attempts: 1,
        error: 'permanent failure',
        state: 'dead-lettered',
      })
      expect(queue.getMetrics().byType['oracle.call'].deadLetter).toBe(1)
    })
  })

  describe('dead-letter and stale-lease operations', () => {
    it('requires force to retry a dead-lettered job and preserves its payload', async () => {
      const queue = new InMemoryJobQueue({ pollIntervalMs: 5 })
      queue.registerHandler('oracle.call', async () => {
        throw new Error('failure')
      })

      queue.enqueue('oracle.call', { oracle: 'test', symbol: 'DLQ' }, { maxAttempts: 1 })
      queue.start()
      await pause(30)
      await queue.stop()

      const [deadLetter] = queue.getDeadLetters()
      expect(() => queue.retryJob(deadLetter.jobId)).toThrow(
        'max_attempts is exhausted. Use ?force=true to retry anyway.',
      )

      const receipt = queue.retryJob(deadLetter.jobId, true)
      expect(receipt).toMatchObject({ id: deadLetter.jobId, type: 'oracle.call', maxAttempts: 1 })
      expect(queue.getDeadLetters()).toHaveLength(0)
      expect(queue.getMetrics().totals.retried).toBe(1)
    })

    it('reclaims an expired active lease for another attempt', async () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const queue = new InMemoryJobQueue({ pollIntervalMs: 10, staleLeaseMs: 300 })
      const releases: Array<() => void> = []
      queue.registerHandler(
        'oracle.call',
        async () => new Promise<void>((resolve) => { releases.push(resolve) }),
      )

      queue.enqueue('oracle.call', { oracle: 'test', symbol: 'LEASE' }, { maxAttempts: 2 })
      queue.start()
      await jest.advanceTimersByTimeAsync(10)
      expect(queue.getMetrics().activeJobs).toBe(1)

      jest.setSystemTime(new Date('2026-01-01T00:00:00.301Z'))
      const result = queue.sweepStaleLeases(300)
      expect(result.reclaimed).toHaveLength(1)
      expect(result.reclaimed[0]).toMatchObject({ type: 'oracle.call', attempt: 1, maxAttempts: 2 })

      const releaseAll = () => {
        while (releases.length > 0) releases.shift()!()
      }
      releaseAll()
      await jest.advanceTimersByTimeAsync(0)
      releaseAll()
      await queue.stop()
    })
  })

  describe('queue depth reporting', () => {
    it('reports queued and delayed jobs by type without dead letters in depth', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const queue = new InMemoryJobQueue()
      queue.registerHandler('notification.send', async () => {})
      queue.registerHandler('oracle.call', async () => {})

      queue.enqueue('notification.send', { recipient: 'a', subject: 's', body: 'b' })
      queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XLM' }, { delayMs: 500 })

      const report = queue.getQueueDepthReport(300)
      expect(report).toMatchObject({ staleLeaseMs: 300, totalDepth: 2 })
      expect(report.byType['notification.send']).toMatchObject({ queued: 1, delayed: 0 })
      expect(report.byType['oracle.call']).toMatchObject({ queued: 0, delayed: 1 })
    })

    it('returns an empty report for a new queue', () => {
      const report = new InMemoryJobQueue().getQueueDepthReport()

      expect(report.totalDepth).toBe(0)
      expect(Object.values(report.byType).every((state) => state.queued === 0 && state.delayed === 0)).toBe(true)
    })
  })
})
