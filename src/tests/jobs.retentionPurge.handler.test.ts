import { describe, expect, it, jest, beforeEach } from '@jest/globals'

const mockPurgeSoftDeletedVaults = jest.fn()
const mockCreateAuditLog = jest.fn()

jest.unstable_mockModule('../services/retention.js', () => ({
  purgeSoftDeletedVaults: mockPurgeSoftDeletedVaults,
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

const { createDefaultJobHandlers } = await import('../jobs/handlers.js')

describe('retention.purge job handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPurgeSoftDeletedVaults.mockResolvedValue({ deletedVaults: 2, deletedMilestones: 3 })
    mockCreateAuditLog.mockResolvedValue({ id: 'audit-retention-1' })
  })

  it('invokes retention purge and writes an audit log summary', async () => {
    const handlers = createDefaultJobHandlers({} as any)

    await handlers['retention.purge'](
      { organizationId: 'org-1', batchSize: 42 },
      { jobId: 'job-123', attempt: 1 },
    )

    expect(mockPurgeSoftDeletedVaults).toHaveBeenCalledWith('org-1', 42)
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'system',
        organization_id: 'org-1',
        action: 'retention.purge',
        target_type: 'organization',
        target_id: 'org-1',
        metadata: {
          deleted_vaults: 2,
          deleted_milestones: 3,
          batch_size: 42,
        },
      }),
    )
  })
})
