import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { parseAndNormalizeToUTC, isValidISO8601 } from '../utils/timestamps.js'

// Mock database layer
let mockVaultMilestones: Array<any> = []

const mockDbChain = {
  join: jest.fn(() => mockDbChain),
  where: jest.fn(() => mockDbChain),
  whereIn: jest.fn(() => mockDbChain),
  whereNotNull: jest.fn(() => mockDbChain),
  select: jest.fn().mockImplementation(async () => mockVaultMilestones),
}

jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn(() => mockDbChain),
}))

// Mock notification service
const mockCreateNotification = jest.fn()

jest.unstable_mockModule('../services/notification.js', () => ({
  createNotification: mockCreateNotification,
}))

// Dynamically import module under test after mocks are registered
const { sendMilestoneReminders } = await import('../services/vaultExpiry.service.js')

describe('vaultExpiry.windows - Deadline Window & Timezone Selection Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVaultMilestones = []
    mockCreateNotification.mockResolvedValue({ id: 'notification-1' })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 1. WINDOW EDGE BOUNDARIES
  // ───────────────────────────────────────────────────────────────────────────
  describe('Window Boundary Selection', () => {
    const LEAD_TIME_1H = 1 * 60 * 60 * 1000 // 3,600,000 ms

    it('excludes milestones exactly at the lower boundary (timeUntilDue = 0)', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const dueDate = new Date(now.getTime()) // timeUntilDue = 0

      mockVaultMilestones = [
        {
          vault_id: 'vault-lower-edge',
          user_id: 'user-1',
          milestone_id: 'ms-lower-edge',
          milestone_title: 'Lower Edge Milestone',
          due_date: dueDate.toISOString(),
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: [LEAD_TIME_1H] })
      expect(count).toBe(0)
      expect(mockCreateNotification).not.toHaveBeenCalled()
    })

    it('includes milestones just inside the lower boundary (timeUntilDue = +1ms)', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const dueDate = new Date(now.getTime() + 1) // timeUntilDue = 1 ms

      mockVaultMilestones = [
        {
          vault_id: 'vault-inside-lower',
          user_id: 'user-1',
          milestone_id: 'ms-inside-lower',
          milestone_title: 'Inside Lower Edge',
          due_date: dueDate.toISOString(),
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: [LEAD_TIME_1H] })
      expect(count).toBe(1)
      expect(mockCreateNotification).toHaveBeenCalledTimes(1)
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency_key: `milestone-reminder-ms-inside-lower-${LEAD_TIME_1H}`,
        })
      )
    })

    it('excludes overdue milestones (timeUntilDue < 0)', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const dueDate = new Date(now.getTime() - 1000) // 1 second overdue

      mockVaultMilestones = [
        {
          vault_id: 'vault-overdue',
          user_id: 'user-1',
          milestone_id: 'ms-overdue',
          milestone_title: 'Overdue Milestone',
          due_date: dueDate.toISOString(),
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: [LEAD_TIME_1H] })
      expect(count).toBe(0)
      expect(mockCreateNotification).not.toHaveBeenCalled()
    })

    it('includes milestones exactly at the upper boundary (timeUntilDue = leadTimeMs)', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const dueDate = new Date(now.getTime() + LEAD_TIME_1H) // timeUntilDue = leadTimeMs

      mockVaultMilestones = [
        {
          vault_id: 'vault-upper-edge',
          user_id: 'user-1',
          milestone_id: 'ms-upper-edge',
          milestone_title: 'Upper Edge Milestone',
          due_date: dueDate.toISOString(),
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: [LEAD_TIME_1H] })
      expect(count).toBe(1)
      expect(mockCreateNotification).toHaveBeenCalledTimes(1)
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency_key: `milestone-reminder-ms-upper-edge-${LEAD_TIME_1H}`,
        })
      )
    })

    it('excludes milestones just outside the upper boundary (timeUntilDue = leadTimeMs + 1ms)', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const dueDate = new Date(now.getTime() + LEAD_TIME_1H + 1) // timeUntilDue = leadTimeMs + 1

      mockVaultMilestones = [
        {
          vault_id: 'vault-outside-upper',
          user_id: 'user-1',
          milestone_id: 'ms-outside-upper',
          milestone_title: 'Outside Upper Edge',
          due_date: dueDate.toISOString(),
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: [LEAD_TIME_1H] })
      expect(count).toBe(0)
      expect(mockCreateNotification).not.toHaveBeenCalled()
    })

    it('correctly evaluates multi-tier lead time boundaries (72h, 24h, 1h)', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const LEAD_TIMES = [72 * 3600 * 1000, 24 * 3600 * 1000, 1 * 3600 * 1000]

      mockVaultMilestones = [
        // Exactly 24 hours away
        {
          vault_id: 'v-24h',
          user_id: 'user-1',
          milestone_id: 'ms-24h',
          milestone_title: '24h Milestone',
          due_date: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
        },
        // Exactly 72 hours away
        {
          vault_id: 'v-72h',
          user_id: 'user-2',
          milestone_id: 'ms-72h',
          milestone_title: '72h Milestone',
          due_date: new Date(now.getTime() + 72 * 3600 * 1000).toISOString(),
        },
        // Slightly beyond 72 hours (72h + 1ms)
        {
          vault_id: 'v-beyond-72h',
          user_id: 'user-3',
          milestone_id: 'ms-beyond-72h',
          milestone_title: 'Beyond 72h Milestone',
          due_date: new Date(now.getTime() + 72 * 3600 * 1000 + 1).toISOString(),
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: LEAD_TIMES })
      expect(count).toBe(2)
      expect(mockCreateNotification).toHaveBeenCalledTimes(2)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. UTC-STORED DEADLINES COMPARISON
  // ───────────────────────────────────────────────────────────────────────────
  describe('UTC-Stored Deadlines Comparison', () => {
    it('compares normalized UTC timestamps accurately against reminder window', async () => {
      const now = new Date('2026-04-25T12:00:00.000Z')
      // Store deadline using parseAndNormalizeToUTC to mirror backend normalization policy
      const normalizedDueDate = parseAndNormalizeToUTC('2026-04-25T14:30:00+02:00') // 12:30:00 UTC (30 min from now)
      expect(normalizedDueDate).toBe('2026-04-25T12:30:00.000Z')
      expect(isValidISO8601(normalizedDueDate)).toBe(true)

      mockVaultMilestones = [
        {
          vault_id: 'v-utc-1',
          user_id: 'user-utc',
          milestone_id: 'ms-utc-1',
          milestone_title: 'UTC Normalized Milestone',
          due_date: normalizedDueDate,
        },
      ]

      const count = await sendMilestoneReminders({
        now,
        leadTimesMs: [1 * 3600 * 1000],
      })
      expect(count).toBe(1)
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ dueDate: '2026-04-25T12:30:00.000Z' }),
        })
      )
    })

    it('handles millisecond precision comparison correctly', async () => {
      const now = new Date('2026-06-15T10:00:00.000Z')
      const leadTimeMs = 1000 // 1 second window

      mockVaultMilestones = [
        {
          vault_id: 'v-ms-1',
          user_id: 'u-ms',
          milestone_id: 'ms-subsecond-inside',
          milestone_title: 'Subsecond Inside',
          due_date: '2026-06-15T10:00:00.999Z', // 999ms from now (inside 1000ms window)
        },
        {
          vault_id: 'v-ms-2',
          user_id: 'u-ms',
          milestone_id: 'ms-subsecond-outside',
          milestone_title: 'Subsecond Outside',
          due_date: '2026-06-15T10:00:01.001Z', // 1001ms from now (outside 1000ms window)
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: [leadTimeMs] })
      expect(count).toBe(1)
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ milestoneId: 'ms-subsecond-inside' }),
        })
      )
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. DST TRANSITIONS HANDLING
  // ───────────────────────────────────────────────────────────────────────────
  describe('DST Transitions Handling', () => {
    it('ensures US Eastern spring-forward transition does not skew reminder window', async () => {
      // US Eastern spring-forward occurs 2026-03-08 at 02:00 EST -> 03:00 EDT
      // now is 2026-03-08 00:30 EST (-05:00) => 2026-03-08T05:30:00.000Z
      const now = new Date(parseAndNormalizeToUTC('2026-03-08T00:30:00-05:00'))
      expect(now.toISOString()).toBe('2026-03-08T05:30:00.000Z')

      // Milestone due at 03:30 EDT (-04:00) => 2026-03-08T07:30:00.000Z (exactly 2 hours / 7200000ms later)
      const springForwardDueDate = parseAndNormalizeToUTC('2026-03-08T03:30:00-04:00')
      expect(springForwardDueDate).toBe('2026-03-08T07:30:00.000Z')

      mockVaultMilestones = [
        {
          vault_id: 'v-spring',
          user_id: 'u-dst',
          milestone_id: 'ms-spring-forward',
          milestone_title: 'Spring Forward Milestone',
          due_date: springForwardDueDate,
        },
      ]

      // Window is exactly 2 hours (7200000 ms)
      const countExact = await sendMilestoneReminders({
        now,
        leadTimesMs: [2 * 3600 * 1000],
      })
      expect(countExact).toBe(1)

      // Window of 1 hour (3600000 ms) should exclude it despite wall-clock hour shift
      const countNarrow = await sendMilestoneReminders({
        now,
        leadTimesMs: [1 * 3600 * 1000],
      })
      expect(countNarrow).toBe(0)
    })

    it('ensures US Eastern fall-back transition maintains deterministic UTC elapsed duration', async () => {
      // US Eastern fall-back occurs 2026-11-01 at 02:00 EDT -> 01:00 EST
      // now is 2026-11-01 01:30 EDT (-04:00) => 2026-11-01T05:30:00.000Z
      const now = new Date(parseAndNormalizeToUTC('2026-11-01T01:30:00-04:00'))
      expect(now.toISOString()).toBe('2026-11-01T05:30:00.000Z')

      // Milestone due 1 hour later at 01:30 EST (-05:00) => 2026-11-01T06:30:00.000Z
      const fallBackDueDate = parseAndNormalizeToUTC('2026-11-01T01:30:00-05:00')
      expect(fallBackDueDate).toBe('2026-11-01T06:30:00.000Z')

      mockVaultMilestones = [
        {
          vault_id: 'v-fall',
          user_id: 'u-dst',
          milestone_id: 'ms-fall-back',
          milestone_title: 'Fall Back Milestone',
          due_date: fallBackDueDate,
        },
      ]

      // Window of 1 hour should include it
      const count = await sendMilestoneReminders({
        now,
        leadTimesMs: [1 * 3600 * 1000],
      })
      expect(count).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. ALREADY-REMINDED EXCLUSION & DEDUPLICATION
  // ───────────────────────────────────────────────────────────────────────────
  describe('Already-Reminded Exclusion and Idempotency', () => {
    it('formats idempotency key strictly per milestone and lead time', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const leadTimeMs = 24 * 3600 * 1000

      mockVaultMilestones = [
        {
          vault_id: 'v-idem-1',
          user_id: 'u-idem',
          milestone_id: 'ms-unique-999',
          milestone_title: 'Idempotent Milestone',
          due_date: new Date(now.getTime() + 12 * 3600 * 1000).toISOString(),
        },
      ]

      await sendMilestoneReminders({ now, leadTimesMs: [leadTimeMs] })

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency_key: `milestone-reminder-ms-unique-999-${leadTimeMs}`,
        })
      )
    })

    it('gracefully handles idempotency collisions and does not crash', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const leadTimeMs = 1 * 3600 * 1000

      mockVaultMilestones = [
        {
          vault_id: 'v-dup-1',
          user_id: 'u-dup',
          milestone_id: 'ms-dup-1',
          milestone_title: 'Duplicate Milestone',
          due_date: new Date(now.getTime() + 1800000).toISOString(),
        },
      ]

      // Simulate notification creation throwing due to existing unique idempotency key
      mockCreateNotification.mockRejectedValueOnce(new Error('Duplicate key value violates unique constraint'))

      const count = await sendMilestoneReminders({ now, leadTimesMs: [leadTimeMs] })
      // When createNotification throws, remindersSent is not incremented for that item
      expect(count).toBe(0)
      expect(mockCreateNotification).toHaveBeenCalledTimes(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. EMPTY WINDOW & EDGE CASES
  // ───────────────────────────────────────────────────────────────────────────
  describe('Empty Window & Execution Options', () => {
    it('returns 0 when no vault milestones are returned', async () => {
      mockVaultMilestones = []
      const count = await sendMilestoneReminders()
      expect(count).toBe(0)
      expect(mockCreateNotification).not.toHaveBeenCalled()
    })

    it('respects execution limit option', async () => {
      const now = new Date('2026-06-01T12:00:00.000Z')
      const leadTimeMs = 1 * 3600 * 1000

      mockVaultMilestones = [
        {
          vault_id: 'v-lim-1',
          user_id: 'u-lim',
          milestone_id: 'ms-lim-1',
          milestone_title: 'Limit MS 1',
          due_date: new Date(now.getTime() + 1000).toISOString(),
        },
        {
          vault_id: 'v-lim-2',
          user_id: 'u-lim',
          milestone_id: 'ms-lim-2',
          milestone_title: 'Limit MS 2',
          due_date: new Date(now.getTime() + 2000).toISOString(),
        },
      ]

      const count = await sendMilestoneReminders({ now, leadTimesMs: [leadTimeMs], limit: 1 })
      expect(count).toBe(1)
      expect(mockCreateNotification).toHaveBeenCalledTimes(1)
    })
  })
})
