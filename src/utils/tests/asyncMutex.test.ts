import { describe, it, expect } from '@jest/globals'
import { AsyncMutex } from '../../utils/asyncMutex.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve after `ms` milliseconds. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AsyncMutex', () => {
  // ── Basic exclusivity ───────────────────────────────────────────────────

  describe('basic exclusivity', () => {
    it('runs a single callback and returns its value', async () => {
      const mutex = new AsyncMutex()
      const result = await mutex.runExclusive(() => 42)
      expect(result).toBe(42)
    })

    it('runs an async callback and returns its value', async () => {
      const mutex = new AsyncMutex()
      const result = await mutex.runExclusive(async () => {
        await delay(1)
        return 'hello'
      })
      expect(result).toBe('hello')
    })

    it('is not locked before or after a call', async () => {
      const mutex = new AsyncMutex()
      expect(mutex.isLocked).toBe(false)
      const p = mutex.runExclusive(() => delay(10))
      expect(mutex.isLocked).toBe(true)
      await p
      expect(mutex.isLocked).toBe(false)
    })

    it('queueLength reflects waiting callers', async () => {
      const mutex = new AsyncMutex()
      const first = mutex.runExclusive(() => delay(20))
      // Two more enqueued while first holds the lock
      const second = mutex.runExclusive(() => 'b')
      const third = mutex.runExclusive(() => 'c')
      expect(mutex.queueLength).toBe(2)
      await Promise.all([first, second, third])
      expect(mutex.queueLength).toBe(0)
    })
  })

  // ── Serialisation ────────────────────────────────────────────────────────

  describe('serialisation', () => {
    it('serialises concurrent callbacks — no overlap', async () => {
      const mutex = new AsyncMutex()
      const log: string[] = []

      const task = (label: string, ms: number) =>
        mutex.runExclusive(async () => {
          log.push(`start:${label}`)
          await delay(ms)
          log.push(`end:${label}`)
        })

      await Promise.all([task('A', 15), task('B', 5), task('C', 1)])

      // Each task must complete before the next starts
      expect(log).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C'])
    })

    it('a shared counter incremented by concurrent tasks reaches exact total', async () => {
      const mutex = new AsyncMutex()
      let counter = 0
      const N = 200

      // Each task does: read → (await) → write, which would race without the mutex
      const tasks = Array.from({ length: N }, () =>
        mutex.runExclusive(async () => {
          const current = counter
          await delay(0) // yield — exposes races when unguarded
          counter = current + 1
        }),
      )

      await Promise.all(tasks)
      expect(counter).toBe(N)
    })

    it('preserves FIFO ordering for waiting tasks', async () => {
      const mutex = new AsyncMutex()
      const order: number[] = []

      // Hold the lock first so all tasks queue up in order
      const hold = mutex.runExclusive(() => delay(20))
      const tasks = [1, 2, 3, 4, 5].map((n) =>
        mutex.runExclusive(() => {
          order.push(n)
        }),
      )

      await hold
      await Promise.all(tasks)
      expect(order).toEqual([1, 2, 3, 4, 5])
    })
  })

  // ── Error handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('re-throws synchronous errors from the callback', async () => {
      const mutex = new AsyncMutex()
      await expect(
        mutex.runExclusive(() => {
          throw new Error('sync boom')
        }),
      ).rejects.toThrow('sync boom')
    })

    it('re-throws async errors from the callback', async () => {
      const mutex = new AsyncMutex()
      await expect(
        mutex.runExclusive(async () => {
          await delay(1)
          throw new Error('async boom')
        }),
      ).rejects.toThrow('async boom')
    })

    it('releases the lock after a throwing callback so subsequent calls proceed', async () => {
      const mutex = new AsyncMutex()

      // First call throws
      await expect(mutex.runExclusive(() => Promise.reject(new Error('oops')))).rejects.toThrow()

      // Mutex should be unlocked; second call must complete normally
      const result = await mutex.runExclusive(() => 'recovered')
      expect(result).toBe('recovered')
      expect(mutex.isLocked).toBe(false)
    })

    it('remaining queue drains normally after a mid-queue error', async () => {
      const mutex = new AsyncMutex()
      const results: string[] = []

      const first = mutex.runExclusive(async () => {
        await delay(5)
        results.push('first')
      })
      const bad = mutex.runExclusive(() => {
        throw new Error('mid error')
      })
      const last = mutex.runExclusive(() => {
        results.push('last')
      })

      await first
      await expect(bad).rejects.toThrow('mid error')
      await last

      expect(results).toEqual(['first', 'last'])
    })
  })

  // ── High-concurrency stress ──────────────────────────────────────────────

  describe('high-concurrency stress', () => {
    it('counter is exact after 1 000 concurrent increments', async () => {
      const mutex = new AsyncMutex()
      let counter = 0
      const N = 1_000

      await Promise.all(
        Array.from({ length: N }, () =>
          mutex.runExclusive(async () => {
            const v = counter
            await delay(0)
            counter = v + 1
          }),
        ),
      )

      expect(counter).toBe(N)
    })

    it('multiple independent mutexes do not interfere', async () => {
      const m1 = new AsyncMutex()
      const m2 = new AsyncMutex()
      let c1 = 0
      let c2 = 0
      const N = 100

      await Promise.all([
        ...Array.from({ length: N }, () =>
          m1.runExclusive(async () => {
            const v = c1
            await delay(0)
            c1 = v + 1
          }),
        ),
        ...Array.from({ length: N }, () =>
          m2.runExclusive(async () => {
            const v = c2
            await delay(0)
            c2 = v + 1
          }),
        ),
      ])

      expect(c1).toBe(N)
      expect(c2).toBe(N)
    })
  })
})
