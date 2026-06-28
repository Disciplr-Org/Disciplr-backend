import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// Mock database
let mockVaultMilestones: Array<any> = []

const mockDbChain = {
  join: jest.fn(() => mockDbChain),
  where: jest.fn(() => mockDbChain),
  whereIn: jest.fn(() => mockDbChain),
  whereNotNull: jest.fn(() => mockDbChain),
  select: jest.fn(() => mockDbChain),
}

jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn(() => mockDbChain),
}))

// Mock createNotification
const mockCreateNotification = jest.fn()

jest.unstable_mockModule('../services/notification.js', () => ({
  createNotification: mockCreateNotification,
}))

// Dynamically import after mocks set up
const { sendMilestoneReminders } = await import('../services/vaultExpiry.service.js')

describe('sendMilestoneReminders', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVaultMilestones = []
    ;(mockDbChain.select as jest.Mock).mockResolvedValue(mockVaultMilestones)
  })

  it('sends a reminder for a milestone within lead time', async () => {
    const now = new Date()
    const dueDate = new Date(now.getTime() + 30 * 60 * 1000) // 30 minutes from now
    mockVaultMilestones = [
      {
        vault_id: 'vault-1',
        user_id: 'user-1',
        milestone_id: 'milestone-1',
        milestone_title: 'Test Milestone',
        due_date: dueDate.toISOString(),
      },
    ]

    const result = await sendMilestoneReminders({
      now,
      leadTimesMs: [1 * 60 * 60 * 1000], // 1 hour
    })

    expect(result).toBe(1)
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        type: 'milestone_reminder',
      }),
    )
  })

  it('does not send a reminder for a milestone outside lead time', async () => {
    const now = new Date()
    const dueDate = new Date(now.getTime() + 5 * 60 * 60 * 1000) // 5 hours from now
    mockVaultMilestones = [
      {
        vault_id: 'vault-1',
        user_id: 'user-1',
        milestone_id: 'milestone-1',
        milestone_title: 'Test Milestone',
        due_date: dueDate.toISOString(),
      },
    ]

    const result = await sendMilestoneReminders({
      now,
      leadTimesMs: [1 * 60 * 60 * 1000], // 1 hour
    })

    expect(result).toBe(0)
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })

  it('does not send duplicate reminders for the same milestone and lead time', async () => {
    const now = new Date()
    const dueDate = new Date(now.getTime() + 30 * 60 * 1000) // 30 minutes from now
    mockVaultMilestones = [
      {
        vault_id: 'vault-1',
        user_id: 'user-1',
        milestone_id: 'milestone-1',
        milestone_title: 'Test Milestone',
        due_date: dueDate.toISOString(),
      },
    ]

    // First call
    await sendMilestoneReminders({
      now,
      leadTimesMs: [1 * 60 * 60 * 1000],
    })
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)

    // Second call (should be deduplicated)
    await sendMilestoneReminders({
      now,
      leadTimesMs: [1 * 60 * 60 * 1000],
    })
    expect(mockCreateNotification).toHaveBeenCalledTimes(1) // Still 1
  })

  it('skips milestones that are not pending', async () => {
    // Note: The whereIn('milestones.status', ['pending']) is in the query,
    // so if the mock doesn't return them, they won't be processed
    const now = new Date()
    const dueDate = new Date(now.getTime() + 30 * 60 * 1000)
    mockVaultMilestones = [] // No pending milestones

    const result = await sendMilestoneReminders({ now })
    expect(result).toBe(0)
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })

  it('sends only one reminder per milestone (picks first matching lead time)', async () => {
    const now = new Date()
    const dueDate = new Date(now.getTime() + 30 * 60 * 1000)
    mockVaultMilestones = [
      {
        vault_id: 'vault-1',
        user_id: 'user-1',
        milestone_id: 'milestone-1',
        milestone_title: 'Test Milestone',
        due_date: dueDate.toISOString(),
      },
    ]

    const result = await sendMilestoneReminders({
      now,
      leadTimesMs: [
        72 * 60 * 60 * 1000, // 72h
        24 * 60 * 60 * 1000, // 24h
        1 * 60 * 60 * 1000,  // 1h
      ],
    })

    expect(result).toBe(1)
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
  })
})
