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
  totals: QueueTotals
  byType: Record<JobType, QueueTypeMetrics>
  recentFailures: FailedJobRecord[]
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
  return {
    'notification.send': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
    'deadline.check': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
    'oracle.call': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
    'analytics.recompute': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
  }
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
    for (const type of JOB_TYPES) {
      queueDepth += byType[type].queued
      delayedJobs += byType[type].delayed
    }

    return {
      running: this.running,
      concurrency: this.concurrency,
      pollIntervalMs: this.pollIntervalMs,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
      queueDepth,
      delayedJobs,
      activeJobs: this.activeJobs.size,
      totals: { ...this.totals },
      byType,
      recentFailures: this.failedJobs.slice(0, 10),
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
    this.activeJobs.set(job.id, job)
    this.totals.executions += 1
    const startedAt = Date.now()

    try {
      await handler(job.payload, {
        jobId: job.id,
        attempt: job.attempt,
      })
      this.recordCompletedJob(job, Date.now() - startedAt)
    } catch (error) {
      const message = getErrorMessage(error)
      if (job.attempt < job.maxAttempts) {
        this.totals.retried += 1
        job.runAt = Date.now() + this.getRetryDelayMs(job.attempt)
        this.pendingJobs.push(job)
        this.sortPendingJobs()
      } else {
        this.recordFailedJob(job, message)
      }
    } finally {
      this.activeJobs.delete(job.id)
      if (this.running) {
        void this.drain()
      }
    }
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
