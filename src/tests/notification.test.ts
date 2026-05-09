import request from 'supertest'
import express from 'express'
import { beforeAll, describe, it, expect, jest } from '@jest/globals'
import fc from 'fast-check'

// ─── Mock DB ────────────────────────────────────────────────────────────────

const mockDb = {
  insert: jest.fn<any>().mockReturnThis(),
  returning: jest.fn<any>().mockReturnThis(),
  where: jest.fn<any>().mockReturnThis(),
  orderBy: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>().mockResolvedValue({}),
  select: jest.fn<any>().mockReturnThis(),
  update: jest.fn<any>().mockReturnThis(),
}

jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn<any>(() => mockDb),
}))

jest.unstable_mockModule('../services/session.js', () => ({
  validateSession: jest.fn<any>().mockResolvedValue(true),
  recordSession: jest.fn<any>().mockResolvedValue(undefined),
  revokeSession: jest.fn<any>().mockResolvedValue(undefined),
  revokeAllUserSessions: jest.fn<any>().mockResolvedValue(undefined),
  forceRevokeUserSessions: jest.fn<any>().mockResolvedValue(undefined),
}))

// ─── App bootstrap ───────────────────────────────────────────────────────────

let app: express.Express
let signToken: any
let createNotification: any
let listUserNotifications: any
let markAsRead: any
let markAllAsRead: any

beforeAll(async () => {
  const authModule = await import('../middleware/auth.js')
  const appModule = await import('../app.js')
  const notifModule = await import('../services/notification.js')

  app = appModule.app
  signToken = authModule.signToken
  createNotification = notifModule.createNotification
  listUserNotifications = notifModule.listUserNotifications
  markAsRead = notifModule.markAsRead
  markAllAsRead = notifModule.markAllAsRead
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeInput = (overrides: Record<string, unknown> = {}) => ({
  user_id: 'user-abc',
  type: 'vault_created',
  title: 'Vault Created',
  message: 'Your vault was created',
  ...overrides,
})

const makeNotification = (overrides: Record<string, unknown> = {}) => ({
  id: 'notif-1',
  user_id: 'user-abc',
  type: 'vault_created',
  title: 'Vault Created',
  message: 'Your vault was created',
  data: null,
  idempotency_key: null,
  read_at: null,
  created_at: new Date().toISOString(),
  ...overrides,
})

// ─── HTTP API tests ───────────────────────────────────────────────────────────

describe('Notifications API', () => {
  it('should list user notifications', async () => {
    const userId = 'user-1'
    const token = await signToken({ sub: userId, role: 'user' })

    mockDb.select.mockResolvedValueOnce([
      { id: '1', user_id: userId, title: 'Test', message: 'Hello', read_at: null },
    ])

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body[0].title).toBe('Test')
  })

  it('should mark a notification as read', async () => {
    const userId = 'user-2'
    const token = await signToken({ sub: userId, role: 'user' })
    const notificationId = 'notif-1'

    mockDb.returning.mockResolvedValueOnce([
      { id: notificationId, read_at: new Date().toISOString() },
    ])

    const res = await request(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.id).toBe(notificationId)
    expect(res.body.read_at).not.toBeNull()
  })

  it('should mark all notifications as read', async () => {
    const userId = 'user-3'
    const token = await signToken({ sub: userId, role: 'user' })

    mockDb.update.mockResolvedValueOnce(5)

    const res = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.message).toMatch(/Marked 5 notifications as read/)
  })

  it('should fail unauthenticated requests', async () => {
    const res = await request(app).get('/api/notifications')
    expect(res.status).toBe(401)
  })
})

// ─── createNotification unit tests ───────────────────────────────────────────

describe('createNotification', () => {
  describe('without idempotency_key (backward compatibility)', () => {
    it('inserts a new row and returns it', async () => {
      const input = makeInput()
      const expected = makeNotification()
      mockDb.returning.mockResolvedValueOnce([expected])

      const result = await createNotification(input)

      expect(mockDb.insert).toHaveBeenCalled()
      expect(result).toEqual(expected)
    })

    it('does not include idempotency_key in the inserted row', async () => {
      const input = makeInput()
      const expected = makeNotification()
      mockDb.returning.mockResolvedValueOnce([expected])

      await createNotification(input)

      const insertedRow = mockDb.insert.mock.calls[mockDb.insert.mock.calls.length - 1][0]
      expect(insertedRow).not.toHaveProperty('idempotency_key')
    })

    it('propagates non-23505 errors', async () => {
      const input = makeInput()
      const dbError = Object.assign(new Error('connection lost'), { code: '08006' })
      mockDb.returning.mockRejectedValueOnce(dbError)

      await expect(createNotification(input)).rejects.toThrow('connection lost')
    })
  })

  describe('with idempotency_key (deduplication)', () => {
    it('inserts and returns a new notification on first call', async () => {
      const input = makeInput({ idempotency_key: 'evt-001' })
      const expected = makeNotification({ idempotency_key: 'evt-001' })
      mockDb.returning.mockResolvedValueOnce([expected])

      const result = await createNotification(input)

      expect(result.idempotency_key).toBe('evt-001')
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('returns existing notification on duplicate (23505 constraint violation)', async () => {
      const input = makeInput({ idempotency_key: 'evt-dup' })
      const existing = makeNotification({ id: 'notif-existing', idempotency_key: 'evt-dup' })

      const uniqueViolation = Object.assign(new Error('unique violation'), { code: '23505' })
      mockDb.returning.mockRejectedValueOnce(uniqueViolation)
      mockDb.first.mockResolvedValueOnce(existing)

      const result = await createNotification(input)

      expect(result).toEqual(existing)
      expect(result.id).toBe('notif-existing')
    })

    it('does not insert a second row on duplicate', async () => {
      const input = makeInput({ idempotency_key: 'evt-dup2' })
      const existing = makeNotification({ idempotency_key: 'evt-dup2' })

      const uniqueViolation = Object.assign(new Error('unique violation'), { code: '23505' })
      mockDb.returning.mockRejectedValueOnce(uniqueViolation)
      mockDb.first.mockResolvedValueOnce(existing)

      const insertCallsBefore = mockDb.insert.mock.calls.length
      await createNotification(input)
      // insert was called once (the original attempt), not twice
      expect(mockDb.insert.mock.calls.length).toBe(insertCallsBefore + 1)
    })

    it('re-throws 23505 when existing row cannot be found (race edge case)', async () => {
      const input = makeInput({ idempotency_key: 'evt-race' })
      const uniqueViolation = Object.assign(new Error('unique violation'), { code: '23505' })
      mockDb.returning.mockRejectedValueOnce(uniqueViolation)
      mockDb.first.mockResolvedValueOnce(undefined) // row disappeared

      await expect(createNotification(input)).rejects.toMatchObject({ code: '23505' })
    })

    it('propagates non-23505 errors even when idempotency_key is set', async () => {
      const input = makeInput({ idempotency_key: 'evt-err' })
      const dbError = Object.assign(new Error('disk full'), { code: '53100' })
      mockDb.returning.mockRejectedValueOnce(dbError)

      await expect(createNotification(input)).rejects.toThrow('disk full')
    })
  })

  describe('observability — no PII in logs', () => {
    it('does not log user_id when creating with key', async () => {
      const input = makeInput({ user_id: 'sensitive-user-id', idempotency_key: 'evt-log1' })
      const expected = makeNotification({ idempotency_key: 'evt-log1' })
      mockDb.returning.mockResolvedValueOnce([expected])

      const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {})
      await createNotification(input)

      for (const call of debugSpy.mock.calls) {
        const output = String(call[0])
        expect(output).not.toContain('sensitive-user-id')
        expect(output).not.toContain('Your vault was created')
      }
      debugSpy.mockRestore()
    })

    it('does not log user_id when suppressing duplicate', async () => {
      const input = makeInput({ user_id: 'sensitive-user-id', idempotency_key: 'evt-log2' })
      const existing = makeNotification({ idempotency_key: 'evt-log2' })

      const uniqueViolation = Object.assign(new Error('unique violation'), { code: '23505' })
      mockDb.returning.mockRejectedValueOnce(uniqueViolation)
      mockDb.first.mockResolvedValueOnce(existing)

      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
      await createNotification(input)

      for (const call of infoSpy.mock.calls) {
        const output = String(call[0])
        expect(output).not.toContain('sensitive-user-id')
        expect(output).not.toContain('Your vault was created')
      }
      infoSpy.mockRestore()
    })

    it('logs idempotency_key and id at debug level on new creation', async () => {
      const input = makeInput({ idempotency_key: 'evt-logkey' })
      const expected = makeNotification({ id: 'notif-logid', idempotency_key: 'evt-logkey' })
      mockDb.returning.mockResolvedValueOnce([expected])

      const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {})
      await createNotification(input)

      const logged = debugSpy.mock.calls.map(c => JSON.parse(String(c[0])))
      const entry = logged.find(l => l.event === 'notification_created_with_key')
      expect(entry).toBeDefined()
      expect(entry.idempotency_key).toBe('evt-logkey')
      expect(entry.id).toBe('notif-logid')
      expect(entry.level).toBe('debug')
      debugSpy.mockRestore()
    })

    it('logs idempotency_key and id at info level on dedup suppression', async () => {
      const input = makeInput({ idempotency_key: 'evt-suppressed' })
      const existing = makeNotification({ id: 'notif-orig', idempotency_key: 'evt-suppressed' })

      const uniqueViolation = Object.assign(new Error('unique violation'), { code: '23505' })
      mockDb.returning.mockRejectedValueOnce(uniqueViolation)
      mockDb.first.mockResolvedValueOnce(existing)

      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
      await createNotification(input)

      const logged = infoSpy.mock.calls.map(c => JSON.parse(String(c[0])))
      const entry = logged.find(l => l.event === 'notification_dedupe_suppressed')
      expect(entry).toBeDefined()
      expect(entry.idempotency_key).toBe('evt-suppressed')
      expect(entry.id).toBe('notif-orig')
      expect(entry.level).toBe('info')
      infoSpy.mockRestore()
    })

    it('does not throw when logger fails', async () => {
      const input = makeInput({ idempotency_key: 'evt-logfail' })
      const expected = makeNotification({ idempotency_key: 'evt-logfail' })
      mockDb.returning.mockResolvedValueOnce([expected])

      // Force JSON.stringify to throw inside the logger
      jest.spyOn(console, 'debug').mockImplementationOnce(() => { throw new Error('logger broken') })

      await expect(createNotification(input)).resolves.toEqual(expected)
    })
  })

  describe('listUserNotifications', () => {
    it('returns notifications ordered by created_at desc', async () => {
      const notifications = [
        makeNotification({ id: 'n2', created_at: '2026-02-26T02:00:00Z' }),
        makeNotification({ id: 'n1', created_at: '2026-02-26T01:00:00Z' }),
      ]
      mockDb.select.mockResolvedValueOnce(notifications)

      const result = await listUserNotifications('user-abc')
      expect(result).toEqual(notifications)
    })
  })

  describe('markAsRead', () => {
    it('returns updated notification', async () => {
      const updated = makeNotification({ read_at: new Date().toISOString() })
      mockDb.returning.mockResolvedValueOnce([updated])

      const result = await markAsRead('notif-1', 'user-abc')
      expect(result).toEqual(updated)
    })

    it('returns null when notification not found', async () => {
      mockDb.returning.mockResolvedValueOnce([])

      const result = await markAsRead('notif-missing', 'user-abc')
      expect(result).toBeNull()
    })
  })

  describe('markAllAsRead', () => {
    it('returns count of updated notifications', async () => {
      mockDb.update.mockResolvedValueOnce(3)

      const result = await markAllAsRead('user-abc')
      expect(result).toBe(3)
    })
  })
})

// ─── Property-based tests ─────────────────────────────────────────────────────

describe('createNotification — property-based', () => {
  const arbitraryKey = () =>
    fc.string({ minLength: 1, maxLength: 255 }).filter(s => s.trim().length > 0)

  const arbitraryInput = () =>
    fc.record({
      user_id: fc.uuid(),
      type: fc.constantFrom('vault_created', 'vault_completed', 'milestone_validated'),
      title: fc.string({ minLength: 1, maxLength: 255 }),
      message: fc.string({ minLength: 20, maxLength: 1000 }),
      idempotency_key: arbitraryKey(),
    })

  it('idempotence: second call with same key returns equivalent notification', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryInput(), async (input) => {
        const notification = makeNotification({
          user_id: input.user_id,
          type: input.type,
          title: input.title,
          message: input.message,
          idempotency_key: input.idempotency_key,
        })

        // First call — insert succeeds
        mockDb.returning.mockResolvedValueOnce([notification])
        const first = await createNotification(input)

        // Second call — unique constraint fires, fetch returns same row
        const uniqueViolation = Object.assign(new Error('unique violation'), { code: '23505' })
        mockDb.returning.mockRejectedValueOnce(uniqueViolation)
        mockDb.first.mockResolvedValueOnce(notification)
        const second = await createNotification(input)

        expect(second.id).toBe(first.id)
        expect(second.idempotency_key).toBe(first.idempotency_key)
      }),
      { numRuns: 20 }
    )
  })

  it('backward compatibility: calls without key always insert a new row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          user_id: fc.uuid(),
          type: fc.constantFrom('vault_created', 'vault_completed'),
          title: fc.string({ minLength: 1, maxLength: 100 }),
          message: fc.string({ minLength: 1, maxLength: 500 }),
        }),
        async (input) => {
          const notification = makeNotification({ user_id: input.user_id })
          mockDb.returning.mockResolvedValueOnce([notification])

          const insertsBefore = mockDb.insert.mock.calls.length
          await createNotification(input) // no idempotency_key
          expect(mockDb.insert.mock.calls.length).toBe(insertsBefore + 1)
        }
      ),
      { numRuns: 20 }
    )
  })

  it('PII safety: log output never contains user_id or message content', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryInput(), async (input) => {
        const notification = makeNotification({
          user_id: input.user_id,
          idempotency_key: input.idempotency_key,
        })

        const logLines: string[] = []
        const debugSpy = jest.spyOn(console, 'debug').mockImplementation((...args) => {
          logLines.push(String(args[0]))
        })
        const infoSpy = jest.spyOn(console, 'info').mockImplementation((...args) => {
          logLines.push(String(args[0]))
        })

        mockDb.returning.mockResolvedValueOnce([notification])
        await createNotification(input)

        debugSpy.mockRestore()
        infoSpy.mockRestore()

        for (const line of logLines) {
          expect(line).not.toContain(input.user_id)
          expect(line).not.toContain(input.message)
        }
      }),
      { numRuns: 20 }
    )
  })
})
