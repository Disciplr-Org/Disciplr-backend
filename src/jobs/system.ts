import { defaultJobHandlers } from './handlers.js'
import { InMemoryJobQueue, type QueueMetrics, type QueuedJobReceipt } from './queue.js'
import { type EnqueueOptions, type JobPayloadByType, type JobType } from './types.js'

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

  constructor() {
    this.queue = new InMemoryJobQueue({
      concurrency: parsePositiveInteger(process.env.JOB_WORKER_CONCURRENCY, 2),
      pollIntervalMs: parsePositiveInteger(process.env.JOB_QUEUE_POLL_INTERVAL_MS, 250),
      historyLimit: parsePositiveInteger(process.env.JOB_HISTORY_LIMIT, 50),
    })

    this.queue.registerHandler('notification.send', defaultJobHandlers['notification.send'])
    this.queue.registerHandler('deadline.check', defaultJobHandlers['deadline.check'])
    this.queue.registerHandler('oracle.call', defaultJobHandlers['oracle.call'])
    this.queue.registerHandler('analytics.recompute', defaultJobHandlers['analytics.recompute'])
  }

  start(): void {
    if (this.started) {
      return
    }

    this.started = true
    this.queue.start()
    this.scheduleRecurringJobs()
  }

  async stop(): Promise<void> {
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
    return this.queue.enqueue(type, payload, options)
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

    const deadlineTimer = setInterval(() => {
      this.enqueue('deadline.check', { triggerSource: 'scheduler' })
    }, deadlineCheckIntervalMs)

    const analyticsTimer = setInterval(() => {
      this.enqueue('analytics.recompute', {
        scope: 'global',
        reason: 'scheduled-refresh',
      })
    }, analyticsIntervalMs)

    if (typeof deadlineTimer.unref === 'function') {
      deadlineTimer.unref()
    }
    if (typeof analyticsTimer.unref === 'function') {
      analyticsTimer.unref()
    }

    this.scheduleTimers.push(deadlineTimer, analyticsTimer)
  }
}
