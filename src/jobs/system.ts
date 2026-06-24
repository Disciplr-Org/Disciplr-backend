import { createDefaultJobHandlers } from './handlers.js'
import { InMemoryJobQueue, type QueueMetrics, type QueuedJobReceipt } from './queue.js'
import { type EnqueueOptions, type JobPayloadByType, type JobType } from './types.js'
import { recoverPendingExportJobs } from '../services/exportQueue.js'
import {
  createNotificationService,
  type NotificationService,
} from '../services/notifications/factory.js'

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}

export class BackgroundJobSystem {
  private readonly queue: InMemoryJobQueue
  private readonly scheduleTimers: NodeJS.Timeout[] = []
  private started = false
  private shuttingDown = false

  constructor(notificationService?: NotificationService) {
    this.queue = new InMemoryJobQueue({
      concurrency: parsePositiveInteger(process.env.JOB_WORKER_CONCURRENCY, 2),
      pollIntervalMs: parsePositiveInteger(process.env.JOB_QUEUE_POLL_INTERVAL_MS, 250),
      historyLimit: parsePositiveInteger(process.env.JOB_HISTORY_LIMIT, 50),
    })
    const resolvedNotificationService =
      notificationService ?? createNotificationService(process.env.NOTIFICATION_PROVIDER ?? 'console')
    const handlers = createDefaultJobHandlers(resolvedNotificationService)

    this.queue.registerHandler('notification.send', handlers['notification.send'])
    this.queue.registerHandler('deadline.check', handlers['deadline.check'])
    this.queue.registerHandler('oracle.call', handlers['oracle.call'])
    this.queue.registerHandler('analytics.recompute', handlers['analytics.recompute'])
    this.queue.registerHandler('export.generate', handlers['export.generate'])
    this.queue.registerHandler('sessions.cleanup', handlers['sessions.cleanup'])
  }

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.shuttingDown = false
    this.queue.start()
    this.scheduleRecurringJobs()
    void recoverPendingExportJobs(this).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[jobs:export.generate] failed to recover pending exports: ${message}`)
    })
  }

  async stop(): Promise<void> {
    this.shuttingDown = true
    for (const timer of this.scheduleTimers) {
      clearInterval(timer)
    }
    this.scheduleTimers.length = 0
    this.started = false
    await this.queue.stop()
  }

  enqueue(
    type: JobType,
    payload: JobPayloadByType[JobType],
    options: EnqueueOptions = {},
  ): QueuedJobReceipt<JobType> {
    if (this.shuttingDown) {
      throw new Error('Cannot enqueue job: system is shutting down')
    }
    return this.queue.enqueue(type, payload, options)
  }

  getDeadLetters() {
    return this.queue.getDeadLetters()
  }

  getDeadLetter(jobId: string) {
    return this.queue.getDeadLetter(jobId)
  }

  replayDeadLetter(jobId: string): QueuedJobReceipt<JobType> {
    if (this.shuttingDown) {
      throw new Error('Cannot replay dead-letter job: system is shutting down')
    }
    return this.queue.replayDeadLetter(jobId)
  }

  retryJob(jobId: string, force: boolean = false): QueuedJobReceipt<JobType> {
    if (this.shuttingDown) {
      throw new Error('Cannot retry job: system is shutting down')
    }
    return this.queue.retryJob(jobId, force)
  }

  getMetrics(): QueueMetrics {
    return this.queue.getMetrics()
  }

  private scheduleRecurringJobs(): void {
    if (process.env.ENABLE_JOB_SCHEDULER === 'false') {
      return
    }

    const deadlineCheckIntervalMs = parsePositiveInteger(
      process.env.DEADLINE_CHECK_INTERVAL_MS,
      60_000,
    )
    const analyticsIntervalMs = parsePositiveInteger(
      process.env.ANALYTICS_RECOMPUTE_INTERVAL_MS,
      300_000,
    )
    const sessionsCleanupIntervalMs = parsePositiveInteger(
      process.env.SESSIONS_CLEANUP_INTERVAL_MS,
      86_400_000, // 24 hours
    )

    this.enqueue('deadline.check', {
      triggerSource: 'scheduler',
    })
    this.enqueue(
      'analytics.recompute',
      {
        scope: 'global',
        reason: 'startup-bootstrap',
      },
      { delayMs: 5_000 },
    )
    this.enqueue('sessions.cleanup', {}, { delayMs: 10_000 })

    const deadlineTimer = setInterval(() => {
      this.enqueue('deadline.check', { triggerSource: 'scheduler' })
    }, deadlineCheckIntervalMs)

    const analyticsTimer = setInterval(() => {
      this.enqueue('analytics.recompute', {
        scope: 'global',
        reason: 'scheduled-refresh',
      })
    }, analyticsIntervalMs)

    const sessionsTimer = setInterval(() => {
      this.enqueue('sessions.cleanup', {})
    }, sessionsCleanupIntervalMs)

    if (typeof deadlineTimer.unref === 'function') {
      deadlineTimer.unref()
    }
    if (typeof analyticsTimer.unref === 'function') {
      analyticsTimer.unref()
    }
    if (typeof sessionsTimer.unref === 'function') {
      sessionsTimer.unref()
    }

    this.scheduleTimers.push(deadlineTimer, analyticsTimer, sessionsTimer)
  }
}
