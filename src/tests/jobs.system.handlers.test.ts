import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BackgroundJobSystem } from '../jobs/system.js'
import { JOB_TYPES } from '../jobs/types.js'

// Mock all external dependencies
vi.mock('../../src/services/exportQueue.js', () => ({
  recoverPendingExportJobs: vi.fn(),
}))

vi.mock('../../src/services/organization.js', () => ({
  listOrganizations: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/services/notifications/factory.js', () => ({
  createNotificationService: vi.fn().mockReturnValue({
    send: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../../src/services/abuse-monitor.js', () => ({
  AbuseMonitor: vi.fn(),
}))

vi.mock('../../src/db/index.js', () => ({
  default: vi.fn(),
}))

vi.mock('../../src/db/pool.js', () => ({
  getPgPool: vi.fn().mockReturnValue(null),
}))

vi.mock('../../src/repositories/milestoneRepository.js', () => ({
  MilestoneRepository: vi.fn().mockImplementation(() => ({
    findMany: vi.fn(),
  })),
}))

vi.mock('../../src/services/backfillCursorStore.js', () => ({
  BackfillCursorStore: vi.fn().mockImplementation(() => ({
    getCursor: vi.fn(),
    setCursor: vi.fn(),
  })),
}))

vi.mock('../../src/services/embeddingProvider.js', () => ({
  createEmbeddingProvider: vi.fn().mockReturnValue({
    embed: vi.fn().mockResolvedValue([]),
  }),
}))

vi.mock('../../src/services/vaultExpiry.service.js', () => ({
  markVaultExpiries: vi.fn().mockResolvedValue(0),
  sendMilestoneReminders: vi.fn().mockResolvedValue(0),
  sendMilestoneDigestReminders: vi.fn().mockResolvedValue({ digestsSent: 0, digestsDeferred: 0, totalMilestones: 0 }),
  processDeferredReminders: vi.fn().mockResolvedValue(0),
}))

vi.mock('../../src/services/session.js', () => ({
  cleanupExpiredSessions: vi.fn().mockResolvedValue(0),
}))

vi.mock('../../src/services/retention.js', () => ({
  purgeSoftDeletedVaults: vi.fn().mockResolvedValue({ deletedVaults: 0, deletedMilestones: 0 }),
}))

vi.mock('../../src/services/outboxRelay.js', () => ({
  relayOutboxBatch: vi.fn().mockResolvedValue(0),
}))

vi.mock('../../src/services/evidenceReindex.js', () => ({
  runReindexBatches: vi.fn().mockResolvedValue({ batches: 0, processed: 0, reindexed: 0, skippedUpToDate: 0, done: true }),
  MilestoneEmbeddingSource: vi.fn(),
  ReindexCursorStore: vi.fn(),
}))

vi.mock('../../src/services/analytics.service.js', () => ({
  renderOrgAnalyticsSnapshot: vi.fn().mockResolvedValue({ snapshotAt: new Date().toISOString() }),
}))

vi.mock('../../src/services/analyticsReports.js', () => ({
  saveOrgReport: vi.fn().mockResolvedValue(undefined),
  getAllOrgIds: vi.fn().mockResolvedValue([]),
  checkAndIncrementReportQuota: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/services/exportS3.js', () => ({
  resolveS3Config: vi.fn().mockReturnValue(null),
  uploadToS3: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/services/soroban.js', () => ({
  buildSlashOnMissPayload: vi.fn().mockReturnValue({ submission: { status: 'mocked' } }),
}))

vi.mock('../../src/lib/audit-logs.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/observability/tracing.js', () => ({
  getTracer: vi.fn().mockReturnValue({
    withSpan: vi.fn().mockImplementation((_name, fn) => fn({ setAttribute: vi.fn() })),
  }),
}))

describe('BackgroundJobSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor handler registration', () => {
    it('registers handlers for all defined JOB_TYPES', () => {
      const system = new BackgroundJobSystem()
      system.start()

      // Every job type should be enqueuable without "No handler registered" error
      for (const jobType of JOB_TYPES) {
        expect(() => {
          system.enqueue(jobType as any, {} as any)
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
          system.enqueue(jobType, {} as any)
        }).not.toThrow('No job handler registered')
      }

      system.stop()
    })

    it('fails with "No handler registered" for unknown job types', () => {
      const system = new BackgroundJobSystem()
      system.start()

      expect(() => {
        system.enqueue('unknown.job.type' as any, {} as any)
      }).toThrow('No job handler registered')

      system.stop()
    })
  })
})