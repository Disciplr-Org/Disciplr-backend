import { randomUUID } from 'node:crypto'
import {
  JOB_TYPES,
  type EnqueueOptions,
  type JobHandler,
  type JobPayloadByType,
  type JobType,
} from './types.js'

interface InternalQueuedJob<T extends JobType = JobType> {
  id: string
  type: T
  payload: JobPayloadByType[T]
  attempt: number
  maxAttempts: number
  createdAt: number
  runAt: number
  activeSince?: number
  leaseId?: number
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

export interface QueueDepthReport {
  generatedAt: string
  totals: {
    queued: number
    delayed: number
    active: number
    deadLetter: number
  }
  byType: Record<JobType, QueueTypeMetrics>
}

export interface StuckJobSweepOptions {
  staleAfterMs?: number
  now?: number
}

export interface StuckJobSweepRecord {
  jobId: string
  type: JobType
  attempt: number
  maxAttempts: number
  activeForMs: number
}

export interface StuckJobSweepResult {
  scannedActive: number
  staleAfterMs: number
  reclaimed: number
  deadLettered: number
  untouched: number
  reclaimedJobs: StuckJobSweepRecord[]
  deadLetteredJobs: StuckJobSweepRecord[]
}

export interface JobQueueOptions {
  concurrency?: number
  pollIntervalMs?: number
  historyLimit?: number
}

const DEFAULT_CONCURRENCY = 2
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_HISTORY_LIMIT = 50
const SHUTDOWN_WAIT_MS = 2_000

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const createEmptyTypeMetrics = (): Record<JobType, QueueTypeMetrics> => {
  return Object.fromEntries(
    JOB_TYPES.map((type) => [
      type,
      { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 },
    ]),
  ) as Record<JobType, QueueTypeMetrics>
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

  private startedAt: number | null = null
  private running = false
  private draining = false
  private pollTimer: NodeJS.Timeout | null = null

  constructor(options: JobQueueOptions = {}) {
    this.concurrency = asPositiveInteger(options.concurrency, DEFAULT_CONCURRENCY)
    this.pollIntervalMs = asPositiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
    this.historyLimit = asPositiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT)
  }

  registerHandler<T extends JobType>(type: T, handler: JobHandler<T>): void {
    this.handlers.set(type, handler as JobHandler)
  }

  enqueue<T extends JobType>(
    type: T,
    payload: JobPayloadByType[T],
    options: EnqueueOptions = {},
  ): QueuedJobReceipt<T> {
    if (!this.handlers.has(type)) {
      throw new Error(`No job handler registered for type: ${type}`)
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

  getDepthReport(): QueueDepthReport {
    const metrics = this.getMetrics()

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        queued: metrics.queueDepth,
        delayed: metrics.delayedJobs,
        active: metrics.activeJobs,
        deadLetter: metrics.deadLetterJobs,
      },
      byType: metrics.byType,
    }
  }

  sweepStuckJobs(options: StuckJobSweepOptions = {}): StuckJobSweepResult {
    const staleAfterMs = asPositiveInteger(options.staleAfterMs, 5 * 60_000)
    const now = options.now ?? Date.now()
    const reclaimedJobs: StuckJobSweepRecord[] = []
    const deadLetteredJobs: StuckJobSweepRecord[] = []
    const activeEntries = [...this.activeJobs.entries()]

    for (const [jobId, job] of activeEntries) {
      const activeSince = job.activeSince ?? now
      const activeForMs = Math.max(0, now - activeSince)
      if (activeForMs < staleAfterMs) {
        continue
      }

      const record: StuckJobSweepRecord = {
        jobId,
        type: job.type,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        activeForMs,
      }

      this.activeJobs.delete(jobId)
      job.activeSince = undefined

      if (job.attempt >= job.maxAttempts) {
        this.moveToDeadLetter(job, `Job lease expired after ${activeForMs}ms`)
        deadLetteredJobs.push(record)
        continue
      }

      job.runAt = now
      this.pendingJobs.push(job)
      reclaimedJobs.push(record)
    }

    if (reclaimedJobs.length > 0) {
      this.sortPendingJobs()
      if (this.running) {
        void this.drain()
      }
    }

    return {
      scannedActive: activeEntries.length,
      staleAfterMs,
      reclaimed: reclaimedJobs.length,
      deadLettered: deadLetteredJobs.length,
      untouched: activeEntries.length - reclaimedJobs.length - deadLetteredJobs.length,
      reclaimedJobs,
      deadLetteredJobs,
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
      this.recordFailedJob(job, 'No handler registered')
      return
    }

    job.attempt += 1
    job.activeSince = Date.now()
    job.leaseId = (job.leaseId ?? 0) + 1
    const leaseId = job.leaseId
    this.activeJobs.set(job.id, job)
    this.totals.executions += 1
    const startedAt = job.activeSince

    try {
      await handler(job.payload, {
        jobId: job.id,
        attempt: job.attempt,
      })
      if (!this.isActiveLease(job.id, leaseId)) {
        return
      }
      this.recordCompletedJob(job, Date.now() - startedAt)
    } catch (error) {
      if (!this.isActiveLease(job.id, leaseId)) {
        return
      }

      const message = getErrorMessage(error)

      // If the handler marked the error as non-retryable, record failure and skip retry
      if (error && (error as any).nonRetryable) {
        this.recordFailedJob(job, message)
      } else if (job.attempt < job.maxAttempts) {
        this.totals.retried += 1
        job.runAt = Date.now() + this.getRetryDelayMs(job.attempt)
        this.pendingJobs.push(job)
        this.sortPendingJobs()
      } else {
        this.moveToDeadLetter(job, message)
      }
    } finally {
      if (this.isActiveLease(job.id, leaseId)) {
        this.activeJobs.delete(job.id)
        job.activeSince = undefined
      }

      if (this.running && !this.draining) {
        void this.drain()
      }
    }
  }

  private isActiveLease(jobId: string, leaseId: number): boolean {
    return this.activeJobs.get(jobId)?.leaseId === leaseId
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

  private moveToDeadLetter(job: InternalQueuedJob<JobType>, error: string): void {
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
    })
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

    const entry = this.deadLetterJobs.splice(index, 1)[0]
    return this.enqueue(entry.type, entry.payload, { maxAttempts: entry.maxAttempts })
  }

  retryJob(jobId: string, force: boolean = false): QueuedJobReceipt<JobType> {
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

    const pendingIndex = this.pendingJobs.findIndex((job) => job.id === jobId)
    if (pendingIndex !== -1) {
      const job = this.pendingJobs[pendingIndex]
      if (job.attempt > 0) {
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

    throw new Error('Job not found or not in a failed state')
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
