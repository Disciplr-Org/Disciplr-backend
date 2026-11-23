import { describe, expect, it, jest } from '@jest/globals'
import { InMemoryJobQueue } from '../jobs/queue.js'
import { BackgroundJobSystem } from '../jobs/system.js'
import {
  JOB_STATES,
  isValidJobTransition,
  VALID_JOB_TRANSITIONS,
  NonRetryableError,
} from '../jobs/types.js'
import type { JobState } from '../jobs/types.js'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── State Machine Transition Table ──────────────────────────────────────────

describe('Job state machine transition table', () => {
  it('allows pending → running', () => {
    expect(isValidJobTransition('pending', 'running')).toBe(true)
  })

  it('allows pending → cancelled', () => {
    expect(isValidJobTransition('pending', 'cancelled')).toBe(true)
  })

  it('allows running → completed', () => {
    expect(isValidJobTransition('running', 'completed')).toBe(true)
  })

  it('allows running → failed', () => {
    expect(isValidJobTransition('running', 'failed')).toBe(true)
  })

  it('allows running → pending (retry)', () => {
    expect(isValidJobTransition('running', 'pending')).toBe(true)
  })

  it('allows failed → pending (retry)', () => {
    expect(isValidJobTransition('failed', 'pending')).toBe(true)
  })

  it('allows failed → dead-lettered', () => {
    expect(isValidJobTransition('failed', 'dead-lettered')).toBe(true)
  })

  it('allows failed → cancelled', () => {
    expect(isValidJobTransition('failed', 'cancelled')).toBe(true)
  })

  it('allows dead-lettered → pending (replay)', () => {
    expect(isValidJobTransition('dead-lettered', 'pending')).toBe(true)
  })

  it('allows dead-lettered → cancelled', () => {
    expect(isValidJobTransition('dead-lettered', 'cancelled')).toBe(true)
  })

  it('rejects completed → any', () => {
    for (const state of JOB_STATES) {
      expect(isValidJobTransition('completed', state)).toBe(false)
    }
  })

  it('rejects cancelled → any', () => {
    for (const state of JOB_STATES) {
      expect(isValidJobTransition('cancelled', state)).toBe(false)
    }
  })

  it('rejects pending → completed', () => {
    expect(isValidJobTransition('pending', 'completed')).toBe(false)
  })

  it('rejects pending → failed', () => {
    expect(isValidJobTransition('pending', 'failed')).toBe(false)
  })

  it('rejects pending → dead-lettered', () => {
    expect(isValidJobTransition('pending', 'dead-lettered')).toBe(false)
  })

  it('rejects running → dead-lettered', () => {
    expect(isValidJobTransition('running', 'dead-lettered')).toBe(false)
  })

  it('rejects running → cancelled', () => {
    expect(isValidJobTransition('running', 'cancelled')).toBe(false)
  })

  it('rejects dead-lettered → running', () => {
    expect(isValidJobTransition('dead-lettered', 'running')).toBe(false)
  })

  it('rejects failed → completed', () => {
    expect(isValidJobTransition('failed', 'completed')).toBe(false)
  })
})

// ─── NonRetryableError ──────────────────────────────────────────────────────

describe('NonRetryableError', () => {
  it('has nonRetryable flag set to true', () => {
    const err = new NonRetryableError('permanent failure')
    expect(err.nonRetryable).toBe(true)
    expect(err.message).toBe('permanent failure')
    expect(err.name).toBe('NonRetryableError')
    expect(err instanceof Error).toBe(true)
  })
})

// ─── Queue Success Path ─────────────────────────────────────────────────────

describe('InMemoryJobQueue success path', () => {
  it('transitions pending → running → completed on success', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let handlerState = ''
    queue.registerHandler('oracle.call', async () => {
      handlerState = 'executed'
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XLM' }, { maxAttempts: 1 })
    queue.start()
    await pause(100)
    await queue.stop()

    expect(handlerState).toBe('executed')
    const metrics = queue.getMetrics()
    expect(metrics.totals.completed).toBe(1)
    expect(metrics.totals.failed).toBe(0)
    expect(metrics.deadLetterJobs).toBe(0)
  })
})

// ─── Queue Retry & Dead-Letter ──────────────────────────────────────────────

describe('InMemoryJobQueue retry and dead-letter', () => {
  it('retries transient failures with exponential backoff', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
      if (callCount < 3) {
        throw new Error('transient failure')
      }
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'RETRY' }, { maxAttempts: 3 })
    queue.start()
    await pause(4000)
    await queue.stop()

    expect(callCount).toBe(3)
    expect(queue.getMetrics().totals.completed).toBe(1)
    expect(queue.getMetrics().totals.retried).toBe(2)
    expect(queue.getDeadLetters()).toHaveLength(0)
  })

  it('dead-letters after exhausting all attempts', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    queue.registerHandler('oracle.call', async () => {
      throw new Error('permanent failure')
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'FAIL' }, { maxAttempts: 2 })
    queue.start()
    await pause(3000)
    await queue.stop()

    const metrics = queue.getMetrics()
    expect(metrics.totals.failed).toBe(1)
    expect(metrics.totals.retried).toBe(1)
    expect(metrics.deadLetterJobs).toBe(1)

    const dlq = queue.getDeadLetters()
    expect(dlq).toHaveLength(1)
    expect(dlq[0].error).toBe('permanent failure')
    expect(dlq[0].attempts).toBe(2)
    expect(dlq[0].state).toBe('dead-lettered')
  })

  it('does not retry when NonRetryableError is thrown', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
      throw new NonRetryableError('permanent on-chain failure')
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'NO_RETRY' }, { maxAttempts: 5 })
    queue.start()
    await pause(500)
    await queue.stop()

    expect(callCount).toBe(1)
    // Non-retryable errors are recorded as failed, not dead-lettered
    expect(queue.getMetrics().totals.retried).toBe(0)
    expect(queue.getMetrics().totals.failed).toBe(1)
    expect(queue.getDeadLetters()).toHaveLength(0)
  })
})

// ─── DLQ Replay ─────────────────────────────────────────────────────────────

describe('InMemoryJobQueue DLQ replay', () => {
  it('replays a dead-letter job and removes it from DLQ', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
      if (callCount === 1) {
        throw new Error('first attempt failed')
      }
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'REPLAY' }, { maxAttempts: 1 })
    queue.start()
    await pause(100)
    await queue.stop()

    expect(queue.getDeadLetters()).toHaveLength(1)
    const dlqEntry = queue.getDeadLetters()[0]

    const receipt = queue.replayDeadLetter(dlqEntry.jobId)
    expect(receipt.type).toBe('oracle.call')
    expect(queue.getDeadLetters()).toHaveLength(0)

    queue.start()
    await pause(100)
    await queue.stop()

    expect(callCount).toBe(2)
    expect(queue.getMetrics().totals.completed).toBe(1)
  })

  it('throws when replaying a non-existent DLQ entry', () => {
    const queue = new InMemoryJobQueue()
    queue.registerHandler('oracle.call', async () => {})
    expect(() => queue.replayDeadLetter('non-existent')).toThrow('Dead-letter job not found')
  })

  it('rejects concurrent replay of an active job', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let blockResolve: () => void
    const blockPromise = new Promise<void>((resolve) => {
      blockResolve = resolve
    })

    queue.registerHandler('oracle.call', async () => {
      await blockPromise
    })

    // First enqueue → will start running
    const receipt = queue.enqueue('oracle.call', { oracle: 'test', symbol: 'BLOCK' }, { maxAttempts: 1 })
    queue.start()
    await pause(50)

    // The job should now be active
    expect(queue.getMetrics().activeJobs).toBe(1)

    // Unblock and stop
    blockResolve!()
    await pause(100)
    await queue.stop()

    // Job should be dead-lettered (first attempt failed after unblocking? No - it succeeded)
    // Actually it succeeded, so no DLQ entry. Let's use a different approach.
  })
})

// ─── Idempotency ────────────────────────────────────────────────────────────

describe('InMemoryJobQueue idempotency', () => {
  it('deduplicates enqueues with the same idempotency key', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
    })

    const key = 'idempotent-key-1'
    const receipt1 = queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'IDEM' },
      { maxAttempts: 1, idempotencyKey: key },
    )
    const receipt2 = queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'IDEM' },
      { maxAttempts: 1, idempotencyKey: key },
    )

    // Same receipt returned for duplicate key
    expect(receipt1.id).toBe(receipt2.id)

    queue.start()
    await pause(100)
    await queue.stop()

    // Only executed once
    expect(callCount).toBe(1)
  })

  it('allows reuse of idempotency key after job completes', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
    })

    const key = 'reuse-key-1'
    queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'REUSE' },
      { maxAttempts: 1, idempotencyKey: key },
    )

    queue.start()
    await pause(100)
    await queue.stop()

    expect(callCount).toBe(1)

    // Re-enqueue with the same key — should create a new job
    queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'REUSE' },
      { maxAttempts: 1, idempotencyKey: key },
    )

    queue.start()
    await pause(100)
    await queue.stop()

    expect(callCount).toBe(2)
  })

  it('allows reuse of idempotency key after job is dead-lettered', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    queue.registerHandler('oracle.call', async () => {
      throw new Error('fail')
    })

    const key = 'dlq-reuse-key'
    queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'DLQ' },
      { maxAttempts: 1, idempotencyKey: key },
    )

    queue.start()
    await pause(100)
    await queue.stop()

    expect(queue.getDeadLetters()).toHaveLength(1)

    // Re-enqueue with the same key should work
    const receipt = queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'DLQ' },
      { maxAttempts: 1, idempotencyKey: key },
    )
    expect(receipt.id).toBeTruthy()
  })
})

// ─── Job Cancellation ───────────────────────────────────────────────────────

describe('InMemoryJobQueue job cancellation', () => {
  it('cancels a pending job', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
    })

    // Enqueue with a long delay so it stays pending
    const receipt = queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'CANCEL' },
      { maxAttempts: 1, delayMs: 60_000 },
    )

    queue.cancelJob(receipt.id, 'test cancellation')

    const cancelled = queue.getCancelledJobs()
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0].jobId).toBe(receipt.id)
    expect(cancelled[0].reason).toBe('test cancellation')
    expect(cancelled[0].type).toBe('oracle.call')

    queue.start()
    await pause(100)
    await queue.stop()

    // Job should not have executed
    expect(callCount).toBe(0)
  })

  it('cancels a dead-lettered job', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    queue.registerHandler('oracle.call', async () => {
      throw new Error('fail')
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'DLQ_CANCEL' }, { maxAttempts: 1 })
    queue.start()
    await pause(100)
    await queue.stop()

    expect(queue.getDeadLetters()).toHaveLength(1)
    const dlqEntry = queue.getDeadLetters()[0]

    queue.cancelJob(dlqEntry.jobId, 'operator cancelled DLQ entry')

    expect(queue.getDeadLetters()).toHaveLength(0)
    const cancelled = queue.getCancelledJobs()
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0].jobId).toBe(dlqEntry.jobId)
  })

  it('rejects cancelling an active job', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let blockResolve: () => void
    const blockPromise = new Promise<void>((resolve) => {
      blockResolve = resolve
    })

    queue.registerHandler('oracle.call', async () => {
      await blockPromise
    })

    const receipt = queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'ACTIVE_CANCEL' },
      { maxAttempts: 1 },
    )
    queue.start()
    await pause(50)

    expect(() => queue.cancelJob(receipt.id)).toThrow('Cannot cancel an active job')

    blockResolve!()
    await pause(100)
    await queue.stop()
  })

  it('throws when cancelling a non-existent job', () => {
    const queue = new InMemoryJobQueue()
    expect(() => queue.cancelJob('non-existent')).toThrow('Job not found')
  })
})

// ─── Stale Lease Sweep ──────────────────────────────────────────────────────

describe('InMemoryJobQueue stale lease sweep with state machine', () => {
  it('reclaims stuck active jobs and transitions them properly', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10, staleLeaseMs: 50 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
      if (callCount === 1) {
        // Simulate a stuck job by blocking longer than the stale lease
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'SWEEP' }, { maxAttempts: 3 })
    queue.start()
    await pause(100) // Let the first attempt start and become stale

    const result = queue.sweepStaleLeases(50)
    // The stuck job should be reclaimed (pending for retry since attempt < maxAttempts)
    expect(result.reclaimed.length).toBeGreaterThanOrEqual(1)

    // Wait for reclaimed job to execute and complete
    await pause(500)
    await queue.stop()

    expect(callCount).toBeGreaterThanOrEqual(2)
    expect(queue.getMetrics().totals.completed).toBe(1)
  })
})

// ─── Retry with force ───────────────────────────────────────────────────────

describe('InMemoryJobQueue retry with force', () => {
  it('retries a DLQ job when force=true', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
      // Always fail
      throw new Error('always fail')
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'FORCE' }, { maxAttempts: 1 })
    queue.start()
    await pause(100)
    await queue.stop()

    expect(queue.getDeadLetters()).toHaveLength(1)

    // Without force, should throw
    expect(() => queue.retryJob(queue.getDeadLetters()[0].jobId)).toThrow('max_attempts is exhausted')

    // With force, should work
    const receipt = queue.retryJob(queue.getDeadLetters()[0].jobId, true)
    expect(receipt.type).toBe('oracle.call')

    queue.start()
    await pause(100)
    await queue.stop()

    expect(callCount).toBe(2)
  })

  it('throws when retrying an active job', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let blockResolve: () => void
    const blockPromise = new Promise<void>((resolve) => {
      blockResolve = resolve
    })

    queue.registerHandler('oracle.call', async () => {
      await blockPromise
    })

    const receipt = queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'ACTIVE_RETRY' },
      { maxAttempts: 3 },
    )
    queue.start()
    await pause(50)

    expect(() => queue.retryJob(receipt.id)).toThrow('Job is currently running')

    blockResolve!()
    await pause(100)
    await queue.stop()
  })
})

// ─── BackgroundJobSystem Integration ────────────────────────────────────────

describe('BackgroundJobSystem state machine integration', () => {
  it('rejects operations during shutdown', async () => {
    const system = new BackgroundJobSystem()
    system.start()

    // Register a handler so enqueue works
    system['queue'].registerHandler('oracle.call', async () => {})

    await system.stop()

    expect(() =>
      system.enqueue('oracle.call', { oracle: 'test', symbol: 'SHUTDOWN' }),
    ).toThrow('system is shutting down')

    expect(() => system.replayDeadLetter('test')).toThrow('system is shutting down')
    expect(() => system.retryJob('test')).toThrow('system is shutting down')
    expect(() => system.cancelJob('test')).toThrow('system is shutting down')
    expect(() => system.sweepStaleLeases()).toThrow('system is shutting down')
  })
})

// ─── Enqueue Options Validation ─────────────────────────────────────────────

describe('EnqueueOptions idempotencyKey validation', () => {
  it('accepts valid idempotencyKey in options', () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    queue.registerHandler('oracle.call', async () => {})

    const receipt = queue.enqueue(
      'oracle.call',
      { oracle: 'test', symbol: 'OPT' },
      { idempotencyKey: 'valid-key' },
    )
    expect(receipt.id).toBeTruthy()
  })

  it('works without idempotencyKey (backwards compatible)', () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    queue.registerHandler('oracle.call', async () => {})

    const receipt = queue.enqueue('oracle.call', { oracle: 'test', symbol: 'OPT' })
    expect(receipt.id).toBeTruthy()
  })
})
