import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { cleanupExpiredSessions } from '../services/session.js'
import { defaultJobHandlers } from '../jobs/handlers.js'
import { JOB_TYPES, isJobType, isPayloadForJobType } from '../jobs/types.js'

describe('cleanupExpiredSessions', () => {
  it('returns 0 when no expired sessions exist', async () => {
    const mockDelete = jest.fn<any>().mockResolvedValue(0)
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    const result = await cleanupExpiredSessions(1000, mockDb as any)
    expect(result).toBe(0)
    expect(mockDelete).toHaveBeenCalledTimes(1)
  })

  it('returns the number of deleted rows in a single batch', async () => {
    const mockDelete = jest.fn<any>().mockResolvedValue(42)
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    const result = await cleanupExpiredSessions(1000, mockDb as any)
    expect(result).toBe(42)
    expect(mockDelete).toHaveBeenCalledTimes(1)
  })

  it('loops until a batch returns fewer rows than batchSize', async () => {
    const mockDelete = jest.fn<any>()
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(300)
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    const result = await cleanupExpiredSessions(1000, mockDb as any)
    expect(result).toBe(1300)
    expect(mockDelete).toHaveBeenCalledTimes(2)
  })

  it('handles exactly batchSize rows then zero on next call', async () => {
    const mockDelete = jest.fn<any>()
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(0)
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    const result = await cleanupExpiredSessions(500, mockDb as any)
    expect(result).toBe(500)
    expect(mockDelete).toHaveBeenCalledTimes(2)
  })

  it('accumulates total across multiple full batches', async () => {
    const mockDelete = jest.fn<any>()
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(50)
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    const result = await cleanupExpiredSessions(100, mockDb as any)
    expect(result).toBe(250)
    expect(mockDelete).toHaveBeenCalledTimes(3)
  })

  it('passes a 30-day cutoff to whereRaw', async () => {
    const mockDelete = jest.fn<any>().mockResolvedValue(0)
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    const before = Date.now()
    await cleanupExpiredSessions(1000, mockDb as any)
    const after = Date.now()

    const cutoffArg: string = mockWhereRaw.mock.calls[0]?.[1]?.[0]
    const cutoffMs = new Date(cutoffArg).getTime()
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000

    expect(cutoffMs).toBeGreaterThanOrEqual(before - thirtyDaysMs - 50)
    expect(cutoffMs).toBeLessThanOrEqual(after - thirtyDaysMs + 50)
  })

  it('passes custom batchSize to andWhereRaw', async () => {
    const mockDelete = jest.fn<any>().mockResolvedValue(0)
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    await cleanupExpiredSessions(250, mockDb as any)
    const args: unknown[] = mockAndWhereRaw.mock.calls[0]?.[1] ?? []
    expect(args).toContain(250)
  })

  it('propagates db errors', async () => {
    const mockDelete = jest.fn<any>().mockRejectedValue(new Error('DB connection lost'))
    const mockAndWhereRaw = jest.fn<any>().mockReturnValue({ delete: mockDelete })
    const mockWhereRaw = jest.fn<any>().mockReturnValue({ andWhereRaw: mockAndWhereRaw })
    const mockDb = jest.fn<any>().mockReturnValue({ whereRaw: mockWhereRaw })

    await expect(cleanupExpiredSessions(1000, mockDb as any)).rejects.toThrow('DB connection lost')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Handler integration tests: we can't mock cleanupExpiredSessions without
// unstable_mockModule (which breaks in this Jest config), so we test the
// type registration instead.
// ──────────────────────────────────────────────────────────────────────────────

describe('sessions.cleanup job handler (smoke test)', () => {
  it('handler is defined in defaultJobHandlers', () => {
    expect(defaultJobHandlers['sessions.cleanup']).toBeDefined()
    expect(typeof defaultJobHandlers['sessions.cleanup']).toBe('function')
  })
})

// ──────────────────────────────────────────────────────────────────────────────

describe('sessions.cleanup job type registration', () => {
  it('sessions.cleanup is included in JOB_TYPES', () => {
    expect(JOB_TYPES).toContain('sessions.cleanup')
  })

  it('isJobType returns true for sessions.cleanup', () => {
    expect(isJobType('sessions.cleanup')).toBe(true)
  })

  it('isPayloadForJobType accepts empty payload', () => {
    expect(isPayloadForJobType('sessions.cleanup', {})).toBe(true)
  })

  it('isPayloadForJobType accepts valid batchSize', () => {
    expect(isPayloadForJobType('sessions.cleanup', { batchSize: 500 })).toBe(true)
  })

  it('isPayloadForJobType rejects negative batchSize', () => {
    expect(isPayloadForJobType('sessions.cleanup', { batchSize: -1 })).toBe(false)
  })

  it('isPayloadForJobType rejects zero batchSize', () => {
    expect(isPayloadForJobType('sessions.cleanup', { batchSize: 0 })).toBe(false)
  })
})
