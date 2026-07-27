import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { initEnv } from '../config/env.js'

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/test'
process.env.DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET || 'test-download-secret'
process.env.ENABLE_JOB_SCHEDULER = 'true'
initEnv(process.env)

const { BackgroundJobSystem } = await import('../jobs/system.js')

describe('BackgroundJobSystem scheduler registration', () => {
  beforeEach(() => {
    process.env.MILESTONE_REMINDERS_INTERVAL_MS = '900000'
    process.env.MILESTONE_REMINDERS_DIGEST_INTERVAL_MS = '900000'
    process.env.MILESTONE_REMINDERS_DEFERRED_INTERVAL_MS = '300000'
  })

  afterEach(() => {
    delete process.env.MILESTONE_REMINDERS_INTERVAL_MS
    delete process.env.MILESTONE_REMINDERS_DIGEST_INTERVAL_MS
    delete process.env.MILESTONE_REMINDERS_DEFERRED_INTERVAL_MS
  })

  it('registers milestone reminder jobs when the scheduler is enabled', () => {
    const system = new BackgroundJobSystem()

    // @ts-ignore Access private scheduler initialization helper for testing.
    ;(system as any).scheduleRecurringJobs()

    const scheduledJobs = (system as any).schedulerRegistry.scheduledJobs as Map<string, unknown>

    expect(Array.from(scheduledJobs.keys())).toEqual(
      expect.arrayContaining([
        'milestone.reminders',
        'milestone.reminders.digest',
        'milestone.reminders.deferred',
      ]),
    )
  })
})
