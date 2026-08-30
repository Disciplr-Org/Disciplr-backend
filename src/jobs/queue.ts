import { randomUUID } from 'node:crypto'
import {
  JOB_TYPES,
  type EnqueueOptions,
  type JobHandler,
  type JobPayloadByType,
  type JobType,
  type JobState,
  isValidJobTransition,
} from './types.js'
import { getTracer } from '../observability/tracing.js'

interface InternalQueuedJob<T extends JobType = JobType> {
  id: string
  type: T
  payload: JobPayloadByType[T]
  attempt: number
  maxAttempts: number
  createdAt: number
  runAt: number
  leasedAt?: number
  state: JobState
  idempotencyKey?: string
}

interface CompletedJobRecord {
  jobId: string
  type: JobType
  completedAt: string
  attempts: number
  durationMs: number
}

interface FailedJobRecord {
  jobId: string
  type: JobType
  failedAt: string
  attempts: number
  error: string
}

export interface DeadLetterJobRecord extends FailedJobRecord {
  payload: JobPayloadByType[JobType]
  createdAt: number
  runAt: number
  maxAttempts: number
  state: JobState
}

export interface CancelledJobRecord {
  jobId: string
  type: JobType
  cancelledAt: string
  attempts: number
  reason: string
}

export interface QueuedJobReceipt<T extends JobType = JobType> {
  id: string
  type: T
  runAt: string
  maxAttempts: number
}

export interface QueueTypeMetrics {
  queued: number
  delayed: number
  active: number
  completed: number
  failed: number
  deadLetter: number
}

export interface QueueTotals {
  enqueued: number
  executions: number
  completed: number
  failed: number
  retried: number
}

export interface QueueMetrics {
  running: boolean
  concurrency: number
  pollIntervalMs: number
  uptimeMs: number
  queueDepth: number
  delayedJobs: number
  activeJobs: number
  deadLetterJobs: number
  totals: QueueTotals
  byType: Record<JobType, QueueTypeMetrics>
  recentFailures: FailedJobRecord[]
}

export interface ReclaimedJobRecord {
  jobId: string
  type: JobType
  attempt: number
  maxAttempts: number
  leaseAgeMs: number
}

export interface SweepResult {
  sweptAt: string
  staleLeaseMs: number
  reclaimed: ReclaimedJobRecord[]
  deadLettered: DeadLetterJobRecord[]
}

export interface QueueDepthByState {
  queued: number
  delayed: number
  active: number
  stuckActive: number
  deadLetter: number
}

export interface QueueDepthReport {
  generatedAt: string
  staleLeaseMs: number
  totalDepth: number
  byType: Record<JobType, QueueDepthByState>
}

export interface JobQueueOptions {
  concurrency?: number
  pollIntervalMs?: number
  historyLimit?: number
  staleLeaseMs?: number
}

const DEFAULT_CONCURRENCY = 2
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_HISTORY_LIMIT = 50
const DEFAULT_STALE_LEASE_MS = 300_000
const SHUTDOWN_WAIT_MS = 2_000

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const createEmptyTypeMetrics = (): Record<JobType, QueueTypeMetrics> => {
  const byType = {} as Record<JobType, QueueTypeMetrics>
  for (const type of JOB_TYPES) {
    byType[type] = { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 }
  }
  return byType
}

const createEmptyDepthByState = (): Record<JobType, QueueDepthByState> => {
  const byType = {} as Record<JobType, QueueDepthByState>
  for (const type of JOB_TYPES) {
    byType[type] = { queued: 0, delayed: 0, active: 0, stuckActive: 0, deadLetter: 0 }
  }
  return byType
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Unknown error'
}

const asPositiveInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

export class InMemoryJobQueue {
  private readonly handlers = new Map<JobType, JobHandler>()
  private readonly pendingJobs: Array<InternalQueuedJob<JobType>> = []
  private readonly activeJobs = new Map<string, InternalQueuedJob<JobType>>()
  private readonly completedJobs: CompletedJobRecord[] = []
  private readonly failedJobs: FailedJobRecord[] = []
  private readonly deadLetterJobs: DeadLetterJobRecord[] = []
  private readonly cancelledJobs: CancelledJobRecord[] = []
  private readonly idempotencyIndex = new Map<string, string>() // idempotencyKey → jobId
  private readonly totals: QueueTotals = {
    enqueued: 0,
    executions: 0,
    completed: 0,
    failed: 0,
    retried: 0,
  }

  private readonly concurrency: number
  private readonly pollIntervalMs: number
  private readonly historyLimit: number
  private readonly staleLeaseMs: number

  private startedAt: number | null = null
  private running = false
  private draining = false
  private pollTimer: NodeJS.Timeout | null = null

  constructor(options: JobQueueOptions = {}) {
    this.concurrency = asPositiveInteger(options.concurrency, DEFAULT_CONCURRENCY)
    this.pollIntervalMs = asPositiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
    this.historyLimit = asPositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT)
    this.staleLeaseMs = asPositiveInteger(options.staleLeaseMs, DEFAULT_STALE_LEASE_MS)
  }

  registerHandler<T extends JobType>(type: T, handler: JobHandler<T>): void {
    this.handlers.set(type, handler as JobHandler)
  }

  /**
   * Atomically validate and apply a state transition. Throws if the
   * transition is invalid, ensuring the state machine invariant is never
   * violated. This is the single choke-point for all state changes.
   */
  private transitionState(job: InternalQueuedJob, to: JobState, context?: string): void {
    const from = job.state
    if (!isValidJobTransition(from, to)) {
      throw new Error(
        `Invalid job state transition: ${from} → ${to} (job ${job.id}${context ? `, ${context}` : ''})`,
      )
    }
    job.state = to
  }

  private findJobById(jobId: string): InternalQueuedJob | undefined {
    const pending = this.pendingJobs.find((j) => j.id === jobId)
    if (pending) return pending
    return this.activeJobs.get(jobId)
  }

  enqueue<T extends JobType>(
    type: T,
    payload: JobPayloadByType[T],
    options: EnqueueOptions = {},
  ): QueuedJobReceipt<T> {
    if (!this.handlers.has(type)) {
      throw new Error(`No job handler registered for type: ${type}`)
    }

    // Idempotency: if an idempotencyKey is provided and already tracked,
    // return the existing receipt instead of creating a duplicate job.
    const idempotencyKey = options.idempotencyKey
    if (idempotencyKey) {
      const existingJobId = this.idempotencyIndex.get(idempotencyKey)
      if (existingJobId) {
        const existingJob = this.findJobById(existingJobId)
        if (existingJob) {
          return {
            id: existingJob.id,
            type: existingJob.type as T,
            runAt: new Date(existingJob.runAt).toISOString(),
            maxAttempts: existingJob.maxAttempts,
          }
        }
        // Key exists but job is gone (completed/cancelled) — fall through to
        // create a fresh job with the same key.
        this.idempotencyIndex.delete(idempotencyKey)
      }
    }

    const now = Date.now()
    const delayMs = Math.max(0, Math.floor(options.delayMs ?? 0))
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3))
    const job: InternalQueuedJob<T> = {
      id: randomUUID(),
      type,
      payload,
      attempt: 0,
      maxAttempts,
      createdAt: now,
      runAt: now + delayMs,
      state: 'pending',
      idempotencyKey,
    }

    if (idempotencyKey) {
      this.idempotencyIndex.set(idempotencyKey, job.id)
    }

    this.pendingJobs.push(job as InternalQueuedJob<JobType>)
    this.sortPendingJobs()
    this.totals.enqueued += 1

    if (this.running) {
      void this.drain()
    }

    return {
      id: job.id,
      type: job.type,
      runAt: new Date(job.runAt).toISOString(),
      maxAttempts: job.maxAttempts,
    }
  }

  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.startedAt = Date.now()
    this.pollTimer = setInterval(() => {
      void this.drain()
    }, this.pollIntervalMs)

    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref()
    }

    void this.drain()
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    this.running = false

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    const stopDeadline = Date.now() + SHUTDOWN_WAIT_MS
    while (this.activeJobs.size > 0 && Date.now() < stopDeadline) {
      await sleep(25)
    }
  }

  getMetrics(): QueueMetrics {
    const now = Date.now()
    const byType = createEmptyTypeMetrics()

    for (const job of this.pendingJobs) {
      if (job.runAt <= now) {
        byType[job.type].queued += 1
      } else {
        byType[job.type].delayed += 1
      }
    }

    for (const job of this.activeJobs.values()) {
      byType[job.type].active += 1
    }

    for (const job of this.completedJobs) {
      byType[job.type].completed += 1
    }

    for (const job of this.failedJobs) {
      byType[job.type].failed += 1
    }

    let queueDepth = 0
    let delayedJobs = 0
    let deadLetterJobs = 0
    for (const type of JOB_TYPES) {
      queueDepth += byType[type].queued
      delayedJobs += byType[type].delayed
    }

    for (const deadLetter of this.deadLetterJobs) {
      byType[deadLetter.type].deadLetter += 1
      deadLetterJobs += 1
    }

    return {
      running: this.running,
      concurrency: this.concurrency,
      pollIntervalMs: this.pollIntervalMs,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
      queueDepth,
      delayedJobs,
      activeJobs: this.activeJobs.size,
      deadLetterJobs,
      totals: { ...this.totals },
      byType,
      recentFailures: this.failedJobs.slice(0, 10),
    }
  }

  getQueueDepthReport(staleLeaseMs: number = this.staleLeaseMs): QueueDepthReport {
    const now = Date.now()
    const byType = createEmptyDepthByState()

    for (const job of this.pendingJobs) {
      if (job.runAt <= now) {
        byType[job.type].queued += 1
      } else {
        byType[job.type].delayed += 1
      }
    }

    for (const job of this.activeJobs.values()) {
      byType[job.type].active += 1
      if (now - job.leasedAt! > staleLeaseMs) {
        byType[job.type].stuckActive += 1
      }
    }

    for (const deadLetter of this.deadLetterJobs) {
      byType[deadLetter.type].deadLetter += 1
    }

    let totalDepth = 0
    for (const type of JOB_TYPES) {
      totalDepth += byType[type].queued + byType[type].delayed + byType[type].active
    }

    return {
      generatedAt: new Date(now).toISOString(),
      staleLeaseMs,
      totalDepth,
      byType,
    }
  }

  sweepStaleLeases(staleLeaseMs: number = this.staleLeaseMs): SweepResult {
    const now = Date.now()
    const reclaimed: ReclaimedJobRecord[] = []
    const deadLettered: DeadLetterJobRecord[] = []

    for (const [jobId, job] of [...this.activeJobs]) {
      const leaseAgeMs = now - job.leasedAt!
      if (leaseAgeMs <= staleLeaseMs) {
        continue
      }

      this.activeJobs.delete(jobId)

      if (job.attempt >= job.maxAttempts) {
        // Atomically transition running → failed (stale lease)
        this.transitionState(job, 'failed', 'stale lease reclaimed')
        this.moveToDeadLetter(
          job,
          `Stuck job reclaimed: lease age ${leaseAgeMs}ms exceeded staleLeaseMs ${staleLeaseMs}ms`,
        )
        deadLettered.push(this.deadLetterJobs[0])
      } else {
        // Atomically transition running → pending (reclaim for retry)
        this.transitionState(job, 'pending', 'stale lease reclaimed')
        this.totals.retried += 1
        job.leasedAt = undefined
        job.runAt = now
        this.pendingJobs.push(job)
        reclaimed.push({
          jobId: job.id,
          type: job.type,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          leaseAgeMs,
        })
      }
    }

    if (reclaimed.length > 0) {
      this.sortPendingJobs()
      if (this.running) {
        void this.drain()
      }
    }

    return {
      sweptAt: new Date(now).toISOString(),
      staleLeaseMs,
      reclaimed,
      deadLettered,
    }
  }

  private async drain(): Promise<void> {
    if (!this.running || this.draining) {
      return
    }

    this.draining = true

    try {
      while (this.running && this.activeJobs.size < this.concurrency) {
        const now = Date.now()
        const nextIndex = this.pendingJobs.findIndex((job) => job.runAt <= now)
        if (nextIndex === -1) {
          return
        }

        const nextJob = this.pendingJobs.splice(nextIndex, 1)[0]
        void this.runJob(nextJob)
      }
    } finally {
      this.draining = false
    }
  }

  private async runJob(job: InternalQueuedJob<JobType>): Promise<void> {
    const handler = this.handlers.get(job.type)
    if (!handler) {
      this.transitionState(job, 'failed', 'no handler')
      this.recordFailedJob(job, 'No handler registered')
      return
    }

    job.attempt += 1
    const startedAt = Date.now()
    job.leasedAt = startedAt

    // Atomically transition pending → running
    this.transitionState(job, 'running', `attempt ${job.attempt}`)

    this.activeJobs.set(job.id, job)
    this.totals.executions += 1

    try {
      const tracer = getTracer()
      await tracer.withSpan(
        `job.${job.type}`,
        async (span) => {
          span.setAttribute('job.type', job.type)
          span.setAttribute('job.id', job.id)
          span.setAttribute('job.attempt', job.attempt)
          span.setAttribute('job.max_attempts', job.maxAttempts)
          await handler(job.payload, {
            jobId: job.id,
            attempt: job.attempt,
          })
        },
      )

      // Check whether sweep reclaimed this job while the handler was running.
      // If sweep removed it from activeJobs and changed its state, we must
      // not attempt any further state transitions — sweep owns the job now.
      if (!this.activeJobs.has(job.id)) {
        return
      }

      // Atomically transition running → completed
      this.transitionState(job, 'completed')
      this.recordCompletedJob(job, Date.now() - startedAt)
    } catch (error) {
      const message = getErrorMessage(error)

      // Check whether sweep reclaimed this job while the handler was running.
      if (!this.activeJobs.has(job.id)) {
        return
      }

      // If the handler marked the error as non-retryable, move to failed
      if (error && (error as any).nonRetryable) {
        this.transitionState(job, 'failed', 'non-retryable')
        this.recordFailedJob(job, message)
      } else if (job.attempt < job.maxAttempts) {
        // Atomically transition running → pending (retry with backoff)
        this.transitionState(job, 'pending', 'retry')
        this.totals.retried += 1
        job.leasedAt = undefined
        job.runAt = Date.now() + this.getRetryDelayMs(job.attempt)
        this.pendingJobs.push(job)
        this.sortPendingJobs()
      } else {
        // Exhausted retries — move to dead-lettered (running → failed → dead-lettered)
        this.transitionState(job, 'failed', 'exhausted retries')
        this.moveToDeadLetter(job, message)
      }
    } finally {
      this.activeJobs.delete(job.id)
      if (this.running) {
        void this.drain()
      }
    }
  }

  private recordFailedJob(job: InternalQueuedJob<JobType>, error: string): void {
    this.totals.failed += 1
    this.failedJobs.unshift({
      jobId: job.id,
      type: job.type,
      failedAt: new Date().toISOString(),
      attempts: job.attempt,
      error,
    })
    this.trimHistory(this.failedJobs)
  }

  private recordCompletedJob(job: InternalQueuedJob<JobType>, durationMs: number): void {
    this.totals.completed += 1
    this.completedJobs.unshift({
      jobId: job.id,
      type: job.type,
      completedAt: new Date().toISOString(),
      attempts: job.attempt,
      durationMs,
    })
    this.trimHistory(this.completedJobs)
  }

  private moveToDeadLetter(job: InternalQueuedJob<JobType>, error: string): void {
    // Atomically transition failed → dead-lettered
    this.transitionState(job, 'dead-lettered', 'max attempts exhausted')

    this.totals.failed += 1
    this.failedJobs.unshift({
      jobId: job.id,
      type: job.type,
      failedAt: new Date().toISOString(),
      attempts: job.attempt,
      error,
    })
    this.trimHistory(this.failedJobs)

    this.deadLetterJobs.unshift({
      jobId: job.id,
      type: job.type,
      failedAt: new Date().toISOString(),
      attempts: job.attempt,
      error,
      payload: job.payload,
      createdAt: job.createdAt,
      runAt: job.runAt,
      maxAttempts: job.maxAttempts,
      state: job.state,
    })

    // Clean up idempotency key so the same key can be reused after DLQ
    if (job.idempotencyKey) {
      this.idempotencyIndex.delete(job.idempotencyKey)
    }
  }

  getDeadLetters(): DeadLetterJobRecord[] {
    return [...this.deadLetterJobs]
  }

  getDeadLetter(jobId: string): DeadLetterJobRecord | undefined {
    return this.deadLetterJobs.find((entry) => entry.jobId === jobId)
  }

  replayDeadLetter(jobId: string): QueuedJobReceipt<JobType> {
    const index = this.deadLetterJobs.findIndex((entry) => entry.jobId === jobId)
    if (index === -1) {
      throw new Error('Dead-letter job not found')
    }

    const entry = this.deadLetterJobs[index]

    // Guard: if the same job is already active or pending (e.g. from a
    // concurrent replay), reject the operation instead of creating a
    // duplicate that would race with the first execution.
    if (this.activeJobs.has(jobId)) {
      throw new Error('Dead-letter job is currently active; cannot replay concurrently')
    }
    const pendingExists = this.pendingJobs.some((j) => j.id === jobId)
    if (pendingExists) {
      throw new Error('Dead-letter job is already pending; cannot replay concurrently')
    }

    // Remove from DLQ
    this.deadLetterJobs.splice(index, 1)

    // Create a fresh job with a new id — reset state to pending
    const receipt = this.enqueue(entry.type, entry.payload, {
      maxAttempts: entry.maxAttempts,
      // Do NOT carry over the old idempotency key; the replay is a
      // distinct operation and should get its own idempotency scope.
    })

    return receipt
  }

  retryJob(jobId: string, force: boolean = false): QueuedJobReceipt<JobType> {
    // Check dead-letter queue first
    const deadLetterIndex = this.deadLetterJobs.findIndex((entry) => entry.jobId === jobId)
    if (deadLetterIndex !== -1) {
      const entry = this.deadLetterJobs[deadLetterIndex]
      if (!force) {
        throw new Error('max_attempts is exhausted. Use ?force=true to retry anyway.')
      }

      this.deadLetterJobs.splice(deadLetterIndex, 1)

      const job: InternalQueuedJob<JobType> = {
        id: entry.jobId,
        type: entry.type,
        payload: entry.payload,
        attempt: 0,
        maxAttempts: entry.maxAttempts,
        createdAt: entry.createdAt,
        runAt: Date.now(),
        state: 'pending',
      }

      this.pendingJobs.push(job)
      this.sortPendingJobs()

      if (this.running) {
        void this.drain()
      }

      return {
        id: job.id,
        type: job.type,
        runAt: new Date(job.runAt).toISOString(),
        maxAttempts: job.maxAttempts,
      }
    }

    // Check active jobs — if a job is currently running, we cannot retry it
    if (this.activeJobs.has(jobId)) {
      throw new Error('Job is currently running; cannot retry an active job')
    }

    // Check pending jobs
    const pendingIndex = this.pendingJobs.findIndex((job) => job.id === jobId)
    if (pendingIndex !== -1) {
      const job = this.pendingJobs[pendingIndex]
      // Only allow retry if the job has been attempted at least once
      // (i.e., it was pulled from pending and failed, then re-enqueued)
      if (job.attempt > 0 && job.state === 'pending') {
        job.runAt = Date.now()
        this.sortPendingJobs()

        if (this.running) {
          void this.drain()
        }

        return {
          id: job.id,
          type: job.type,
          runAt: new Date(job.runAt).toISOString(),
          maxAttempts: job.maxAttempts,
        }
      }
    }

    throw new Error('Job not found or not in a retryable state')
  }

  cancelJob(jobId: string, reason: string = 'operator cancel'): void {
    // Check active jobs — cancel by transitioning running → failed, then
    // the failed state can be cleaned up. Active jobs cannot go directly
    // to cancelled; they must finish their current execution first.
    const activeJob = this.activeJobs.get(jobId)
    if (activeJob) {
      throw new Error('Cannot cancel an active job; let it finish or sweep its stale lease')
    }

    // Check pending jobs — cancel by transitioning pending → cancelled
    const pendingIndex = this.pendingJobs.findIndex((job) => job.id === jobId)
    if (pendingIndex !== -1) {
      const job = this.pendingJobs[pendingIndex]
      this.transitionState(job, 'cancelled', reason)
      this.pendingJobs.splice(pendingIndex, 1)
      this.cancelledJobs.unshift({
        jobId: job.id,
        type: job.type,
        cancelledAt: new Date().toISOString(),
        attempts: job.attempt,
        reason,
      })
      this.trimHistory(this.cancelledJobs)
      return
    }

    // Check dead-letter jobs — cancel by transitioning dead-lettered → cancelled
    const deadLetterIndex = this.deadLetterJobs.findIndex((entry) => entry.jobId === jobId)
    if (deadLetterIndex !== -1) {
      const entry = this.deadLetterJobs[deadLetterIndex]
      this.deadLetterJobs.splice(deadLetterIndex, 1)
      this.cancelledJobs.unshift({
        jobId: entry.jobId,
        type: entry.type,
        cancelledAt: new Date().toISOString(),
        attempts: entry.attempts,
        reason,
      })
      this.trimHistory(this.cancelledJobs)
      return
    }

    throw new Error('Job not found')
  }

  getCancelledJobs(): CancelledJobRecord[] {
    return [...this.cancelledJobs]
  }

  private trimHistory(records: unknown[]): void {
    if (records.length > this.historyLimit) {
      records.length = this.historyLimit
    }
  }

  private getRetryDelayMs(attempt: number): number {
    return Math.min(60_000, 1_000 * 2 ** (attempt - 1))
  }

  private sortPendingJobs(): void {
    this.pendingJobs.sort((left, right) => left.runAt - right.runAt)
  }
}
