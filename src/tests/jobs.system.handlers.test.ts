import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type { JobPayloadByType, JobType } from '../jobs/types.js'

// Mock all external dependencies. Mock modules must be registered with
// jest.unstable_mockModule before the modules under test are imported, so
// BackgroundJobSystem and JOB_TYPES are loaded via dynamic import below.
jest.unstable_mockModule('../../src/services/exportQueue.js', () => ({
  recoverPendingExportJobs: jest.fn().mockResolvedValue(undefined),
  processJob: jest.fn().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('../../src/services/organization.js', () => ({
  listOrganizations: jest.fn().mockResolvedValue([]),
}))

jest.unstable_mockModule('../../src/services/notifications/factory.js', () => ({
  createNotificationService: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue(undefined),
  }),
}))

jest.unstable_mockModule('../../src/services/abuse-monitor.js', () => ({
  AbuseMonitor: jest.fn(),
}))

jest.unstable_mockModule('../../src/db/index.js', () => ({
  default: jest.fn(),
}))

jest.unstable_mockModule('../../src/db/pool.js', () => ({
  getPgPool: jest.fn().mockReturnValue(null),
}))

jest.unstable_mockModule('../../src/repositories/milestoneRepository.js', () => ({
  MilestoneRepository: jest.fn().mockImplementation(() => ({
    findMany: jest.fn(),
  })),
}))

jest.unstable_mockModule('../../src/services/backfillCursorStore.js', () => ({
  BackfillCursorStore: jest.fn().mockImplementation(() => ({
    getCursor: jest.fn(),
    setCursor: jest.fn(),
  })),
}))

jest.unstable_mockModule('../../src/services/embeddingProvider.js', () => ({
  createEmbeddingProvider: jest.fn().mockReturnValue({
    embed: jest.fn().mockResolvedValue([]),
  }),
}))

jest.unstable_mockModule('../../src/services/vaultExpiry.service.js', () => ({
  markVaultExpiries: jest.fn().mockResolvedValue(0),
  sendMilestoneReminders: jest.fn().mockResolvedValue(0),
  sendMilestoneDigestReminders: jest.fn().mockResolvedValue({ digestsSent: 0, digestsDeferred: 0, totalMilestones: 0 }),
  processDeferredReminders: jest.fn().mockResolvedValue(0),
}))

jest.unstable_mockModule('../../src/services/session.js', () => ({
  cleanupExpiredSessions: jest.fn().mockResolvedValue(0),
}))

jest.unstable_mockModule('../../src/services/retention.js', () => ({
  purgeSoftDeletedVaults: jest.fn().mockResolvedValue({ deletedVaults: 0, deletedMilestones: 0 }),
}))

jest.unstable_mockModule('../../src/services/outboxRelay.js', () => ({
  relayOutboxBatch: jest.fn().mockResolvedValue(0),
}))

jest.unstable_mockModule('../../src/services/evidenceReindex.js', () => ({
  runReindexBatches: jest.fn().mockResolvedValue({ batches: 0, processed: 0, reindexed: 0, skippedUpToDate: 0, done: true }),
  MilestoneEmbeddingSource: jest.fn(),
  ReindexCursorStore: jest.fn(),
}))

jest.unstable_mockModule('../../src/services/analytics.service.js', () => ({
  renderOrgAnalyticsSnapshot: jest.fn().mockResolvedValue({ snapshotAt: new Date().toISOString() }),
}))

jest.unstable_mockModule('../../src/services/analyticsReports.js', () => ({
  saveOrgReport: jest.fn().mockResolvedValue(undefined),
  getAllOrgIds: jest.fn().mockResolvedValue([]),
  checkAndIncrementReportQuota: jest.fn().mockResolvedValue(true),
}))

jest.unstable_mockModule('../../src/services/exportS3.js', () => ({
  resolveS3Config: jest.fn().mockReturnValue(null),
  uploadToS3: jest.fn().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('../../src/services/soroban.js', () => ({
  buildSlashOnMissPayload: jest.fn().mockReturnValue({ submission: { status: 'mocked' } }),
  submitSlash: jest.fn().mockResolvedValue(undefined),
  getSorobanConfig: jest.fn().mockReturnValue(null),
  getSorobanClient: jest.fn().mockReturnValue(null),
}))

jest.unstable_mockModule('../../src/lib/audit-logs.js', () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}))

jest.unstable_mockModule('../../src/observability/tracing.js', () => ({
  getTracer: jest.fn().mockReturnValue({
    withSpan: jest.fn().mockImplementation((_name, fn) => fn({ setAttribute: jest.fn() })),
  }),
}))

const { BackgroundJobSystem } = await import('../jobs/system.js')
const { JOB_TYPES } = await import('../jobs/types.js')

describe('BackgroundJobSystem', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('constructor handler registration', () => {
    it('registers handlers for all defined JOB_TYPES', () => {
      const system = new BackgroundJobSystem()
      system.start()

      // Every job type should be enqueuable without "No handler registered" error
      for (const jobType of JOB_TYPES) {
        expect(() => {
          system.enqueue(jobType, {} as JobPayloadByType[JobType])
        }).not.toThrow('No job handler registered')
      }

      system.stop()
    })

    it('registers the four previously-missing handler types', () => {
      const system = new BackgroundJobSystem()
      system.start()

      // These four were specifically called out in issue #1381
      const previouslyMissingTypes = [
        'milestone.reminders',
        'milestone.reminders.digest',
        'milestone.reminders.deferred',
        'vault.reconcile',
      ] as const

      for (const jobType of previouslyMissingTypes) {
        expect(() => {
          system.enqueue(jobType, {} as JobPayloadByType[JobType])
        }).not.toThrow('No job handler registered')
      }

      system.stop()
    })

    // The guard lives in BackgroundJobSystem.enqueue now: it rejects unknown
    // types with "Cannot enqueue unregistered job type" before the queue is
    // reached, so the queue's "No job handler registered" error no longer
    // surfaces for this case.
    it('fails with "Cannot enqueue unregistered job type" for unknown job types', () => {
      const system = new BackgroundJobSystem()
      system.start()

      expect(() => {
        system.enqueue('unknown.job.type' as unknown as JobType, {} as JobPayloadByType[JobType])
      }).toThrow('Cannot enqueue unregistered job type')

      system.stop()
    })
  })
})
