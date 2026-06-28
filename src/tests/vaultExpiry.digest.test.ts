import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import type { MilestoneReminderItem } from '../types/notification.js'

// Mock data
let mockVaultMilestones: Array<any> = []
let mockNotifications: Array<any> = []
let mockDeferredReminders: Array<any> = []
let mockUserPreferences: Map<string, any> = new Map()

// Mock database chain
const mockDbChain = {
  join: vi.fn(() => mockDbChain),
  where: vi.fn(() => mockDbChain),
  andWhere: vi.fn(() => mockDbChain),
  whereIn: vi.fn(() => mockDbChain),
  whereNotNull: vi.fn(() => mockDbChain),
  select: vi.fn(() => Promise.resolve(mockVaultMilestones)),
  first: vi.fn(() => Promise.resolve(null)),
  insert: vi.fn(() => ({
    onConflict: vi.fn(() => ({
      merge: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: 'deferred-1' }])),
      })),
    })),
    returning: vi.fn(() => Promise.resolve([{ id: 'notification-1' }])),
  })),
}

vi.mock('../db/index.js', () => ({
  default: vi.fn((table: string) => {
    if (table === 'notifications') {
      return {
        ...mockDbChain,
        first: vi.fn(() => {
          const key = mockDbChain.where.mock.calls?.[0]?.[1]
          return Promise.resolve(mockNotifications.find(n => n.idempotency_key === key) || null)
        }),
      }
    }
    return mockDbChain
  }),
}))

// Mock notification service
const mockCreateNotification = vi.fn().mockResolvedValue({ id: 'notification-1' })

vi.mock('../services/notification.js', () => ({
  createNotification: (...args: any[]) => mockCreateNotification(...args),
}))

// Mock user preferences service
vi.mock('../services/userNotificationPreferences.service.js', () => ({
  getUserPreferencesBatch: vi.fn((userIds: string[]) => {
    const result = new Map()
    for (const userId of userIds) {
      result.set(userId, mockUserPreferences.get(userId) || {
        id: '',
        user_id: userId,
        timezone: 'UTC',
        quiet_hours_enabled: false,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    }
    return Promise.resolve(result)
  }),
}))

// Mock deferred reminders service
const mockStoreDeferredReminder = vi.fn().mockResolvedValue({ id: 'deferred-1' })

vi.mock('../services/deferredReminders.service.js', () => ({
  storeDeferredReminder: (...args: any[]) => mockStoreDeferredReminder(...args),
  claimDueReminders: vi.fn(() => Promise.resolve(mockDeferredReminders)),
}))

// Import after mocks
const { sendMilestoneDigestReminders, processDeferredReminders } = await import('../services/vaultExpiry.service.js')

describe('sendMilestoneDigestReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVaultMilestones = []
    mockNotifications = []
    mockDeferredReminders = []
    mockUserPreferences = new Map()
    mockDbChain.select.mockResolvedValue(mockVaultMilestones)
  })

  describe('single-vault digest', () => {
    it('sends one notification for one milestone', async () => {
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
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      const result = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000], // 1 hour
      })

      expect(result.digestsSent).toBe(1)
      expect(result.totalMilestones).toBe(1)
      expect(result.digestsDeferred).toBe(0)
    })
  })

  describe('many-vault digest', () => {
    it('batches multiple milestones into single notification per user', async () => {
      const now = new Date()
      const dueDate1 = new Date(now.getTime() + 20 * 60 * 1000) // 20 minutes
      const dueDate2 = new Date(now.getTime() + 30 * 60 * 1000) // 30 minutes
      const dueDate3 = new Date(now.getTime() + 40 * 60 * 1000) // 40 minutes

      mockVaultMilestones = [
        {
          vault_id: 'vault-1',
          user_id: 'user-1',
          milestone_id: 'milestone-1',
          milestone_title: 'Milestone 1',
          due_date: dueDate1.toISOString(),
        },
        {
          vault_id: 'vault-2',
          user_id: 'user-1',
          milestone_id: 'milestone-2',
          milestone_title: 'Milestone 2',
          due_date: dueDate2.toISOString(),
        },
        {
          vault_id: 'vault-3',
          user_id: 'user-1',
          milestone_id: 'milestone-3',
          milestone_title: 'Milestone 3',
          due_date: dueDate3.toISOString(),
        },
      ]
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      const result = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000],
      })

      expect(result.digestsSent).toBe(1)
      expect(result.totalMilestones).toBe(3)
    })

    it('groups by user correctly when multiple users have reminders', async () => {
      const now = new Date()
      const dueDate = new Date(now.getTime() + 30 * 60 * 1000)

      mockVaultMilestones = [
        {
          vault_id: 'vault-1',
          user_id: 'user-1',
          milestone_id: 'milestone-1',
          milestone_title: 'User 1 Milestone 1',
          due_date: dueDate.toISOString(),
        },
        {
          vault_id: 'vault-2',
          user_id: 'user-1',
          milestone_id: 'milestone-2',
          milestone_title: 'User 1 Milestone 2',
          due_date: dueDate.toISOString(),
        },
        {
          vault_id: 'vault-3',
          user_id: 'user-2',
          milestone_id: 'milestone-3',
          milestone_title: 'User 2 Milestone 1',
          due_date: dueDate.toISOString(),
        },
        {
          vault_id: 'vault-4',
          user_id: 'user-2',
          milestone_id: 'milestone-4',
          milestone_title: 'User 2 Milestone 2',
          due_date: dueDate.toISOString(),
        },
      ]
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      const result = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000],
      })

      expect(result.digestsSent).toBe(2) // One digest per user
      expect(result.totalMilestones).toBe(4)
    })
  })

  describe('quiet-hours deferral', () => {
    it('defers reminder when user is in quiet hours', async () => {
      const now = new Date('2024-06-15T03:00:00Z') // 03:00 UTC
      const dueDate = new Date(now.getTime() + 30 * 60 * 1000)

      mockVaultMilestones = [
        {
          vault_id: 'vault-1',
          user_id: 'user-quiet',
          milestone_id: 'milestone-1',
          milestone_title: 'Test Milestone',
          due_date: dueDate.toISOString(),
        },
      ]
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      // Set up quiet hours for user (22:00-08:00 UTC)
      mockUserPreferences.set('user-quiet', {
        id: 'pref-1',
        user_id: 'user-quiet',
        timezone: 'UTC',
        quiet_hours_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const result = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000],
      })

      expect(result.digestsDeferred).toBe(1)
      expect(result.digestsSent).toBe(0)
      expect(mockStoreDeferredReminder).toHaveBeenCalled()
    })

    it('sends immediately when user is outside quiet hours', async () => {
      const now = new Date('2024-06-15T14:00:00Z') // 14:00 UTC - outside quiet hours
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
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      // Set up quiet hours for user (22:00-08:00 UTC)
      mockUserPreferences.set('user-1', {
        id: 'pref-1',
        user_id: 'user-1',
        timezone: 'UTC',
        quiet_hours_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const result = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000],
      })

      expect(result.digestsSent).toBe(1)
      expect(result.digestsDeferred).toBe(0)
    })

    it('handles users without preferences (uses defaults)', async () => {
      const now = new Date('2024-06-15T14:00:00Z')
      const dueDate = new Date(now.getTime() + 30 * 60 * 1000)

      mockVaultMilestones = [
        {
          vault_id: 'vault-1',
          user_id: 'user-no-prefs',
          milestone_id: 'milestone-1',
          milestone_title: 'Test Milestone',
          due_date: dueDate.toISOString(),
        },
      ]
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      // No preferences set for user - defaults should be used (quiet_hours_enabled = false)
      const result = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000],
      })

      expect(result.digestsSent).toBe(1)
      expect(result.digestsDeferred).toBe(0)
    })
  })

  describe('idempotency', () => {
    it('uses idempotency keys to prevent duplicates', async () => {
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
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      // First run - should send
      const result1 = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000],
      })

      expect(result1.digestsSent).toBe(1)
      expect(result1.totalMilestones).toBe(1)

      // Verify createNotification was called with idempotency key
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency_key: expect.stringContaining('milestone-in-digest-milestone-1'),
        }),
      )
    })
  })

  describe('limit parameter', () => {
    it('respects limit parameter', async () => {
      const now = new Date()
      const dueDate = new Date(now.getTime() + 30 * 60 * 1000)

      mockVaultMilestones = [
        {
          vault_id: 'vault-1',
          user_id: 'user-1',
          milestone_id: 'milestone-1',
          milestone_title: 'Milestone 1',
          due_date: dueDate.toISOString(),
        },
        {
          vault_id: 'vault-2',
          user_id: 'user-2',
          milestone_id: 'milestone-2',
          milestone_title: 'Milestone 2',
          due_date: dueDate.toISOString(),
        },
        {
          vault_id: 'vault-3',
          user_id: 'user-3',
          milestone_id: 'milestone-3',
          milestone_title: 'Milestone 3',
          due_date: dueDate.toISOString(),
        },
      ]
      mockDbChain.select.mockResolvedValue(mockVaultMilestones)

      const result = await sendMilestoneDigestReminders({
        now,
        leadTimesMs: [1 * 60 * 60 * 1000],
        limit: 2,
      })

      // Should only process 2 digests due to limit
      expect(result.digestsSent).toBeLessThanOrEqual(2)
    })
  })
})

describe('processDeferredReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeferredReminders = []
  })

  it('processes reminders when deliver_after is past', async () => {
    const items: MilestoneReminderItem[] = [
      {
        vault_id: 'vault-1',
        milestone_id: 'milestone-1',
        milestone_title: 'Test Milestone',
        due_date: new Date().toISOString(),
        lead_time_ms: 3600000,
        lead_time_text: '1 hour',
      },
    ]

    mockDeferredReminders = [
      {
        id: 'deferred-1',
        user_id: 'user-1',
        idempotency_key: 'digest-reminders-user-1-12345',
        reminder_data: {
          user_id: 'user-1',
          items,
          digest_idempotency_key: 'digest-reminders-user-1-12345',
          run_timestamp: new Date().toISOString(),
        },
        deliver_after: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        created_at: new Date().toISOString(),
      },
    ]

    const result = await processDeferredReminders({ batchSize: 50 })

    expect(result).toBe(1)
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        type: 'milestone_digest',
      }),
    )
  })
})

describe('digestRenderer', () => {
  // Import synchronously since we're not mocking digestRenderer
  let renderDigestTitle: (items: MilestoneReminderItem[]) => string
  let renderDigestMessage: (options: { items: MilestoneReminderItem[]; locale?: string; timezone?: string }) => string
  let formatLeadTime: (leadTimeMs: number) => string

  beforeAll(async () => {
    const module = await import('../services/digestRenderer.js')
    renderDigestTitle = module.renderDigestTitle
    renderDigestMessage = module.renderDigestMessage
    formatLeadTime = module.formatLeadTime
  })

  describe('renderDigestTitle', () => {
    it('returns "Milestone Reminder: {title}" for single item', () => {
      const items: MilestoneReminderItem[] = [
        {
          vault_id: 'vault-1',
          milestone_id: 'milestone-1',
          milestone_title: 'Test Milestone',
          due_date: new Date().toISOString(),
          lead_time_ms: 3600000,
          lead_time_text: '1 hour',
        },
      ]
      expect(renderDigestTitle(items)).toBe('Milestone Reminder: Test Milestone')
    })

    it('returns "{n} Milestone Reminders" for multiple items', () => {
      const items: MilestoneReminderItem[] = [
        {
          vault_id: 'vault-1',
          milestone_id: 'milestone-1',
          milestone_title: 'Test 1',
          due_date: new Date().toISOString(),
          lead_time_ms: 3600000,
          lead_time_text: '1 hour',
        },
        {
          vault_id: 'vault-2',
          milestone_id: 'milestone-2',
          milestone_title: 'Test 2',
          due_date: new Date().toISOString(),
          lead_time_ms: 3600000,
          lead_time_text: '1 hour',
        },
      ]
      expect(renderDigestTitle(items)).toBe('2 Milestone Reminders')
    })
  })

  describe('formatLeadTime', () => {
    it('formats minutes correctly', () => {
      expect(formatLeadTime(30 * 60 * 1000)).toBe('30 minutes')
      expect(formatLeadTime(1 * 60 * 1000)).toBe('1 minute')
    })

    it('formats hours correctly', () => {
      expect(formatLeadTime(1 * 60 * 60 * 1000)).toBe('1 hour')
      expect(formatLeadTime(24 * 60 * 60 * 1000)).toBe('1 day')
      expect(formatLeadTime(72 * 60 * 60 * 1000)).toBe('3 days')
    })
  })
})
