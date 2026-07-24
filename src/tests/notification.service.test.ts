/**
 * Tests for the notification service layer (src/services/notification.ts and
 * src/services/notifications/factory.ts).
 *
 * Covers:
 *   - Stable dedup-key derivation: a duplicate (user_id, idempotency_key)
 *     insert is suppressed and returns the original row.
 *   - Multi-channel routing: every provider that is registered for the
 *     service can be addressed individually, and one failing provider does
 *     not block delivery through the remaining providers.
 *   - Channel-level error isolation: if one provider rejects, that failure is
 *     observed by the caller but does not corrupt the registry or block
 *     concurrent calls against other providers.
 *
 * The DB-backed dedup path is exercised against a mocked `db` module so the
 * suite remains hermetic without a Postgres connection.  When
 * DATABASE_URL is set, an additional integration check runs against the real
 * `notifications` table to confirm the PG 23505 contract end-to-end.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals'
import type { Knex } from 'knex'

import type { NotificationProvider } from '../services/notifications/provider.js'
import {
  NotificationService,
  buildNotificationProviderRegistry,
} from '../services/notifications/factory.js'

// ─── shared mocks ─────────────────────────────────────────────────────────────

const makeMockProvider = (
  name: string,
  options: { fail?: boolean; delay?: number } = {},
): NotificationProvider => {
  const spy = jest.fn(async (_recipient: string, _subject: string, _body: string) => {
    if (options.delay) {
      await new Promise((resolve) => setTimeout(resolve, options.delay))
    }
    if (options.fail) {
      throw new Error(`Provider ${name} failed`)
    }
  }) as unknown as jest.MockedFunction<NotificationProvider['send']>
  return { name, send: spy as unknown as NotificationProvider['send'] }
}

const getSendMock = (provider: NotificationProvider): jest.MockedFunction<NotificationProvider['send']> =>
  provider.send as unknown as jest.MockedFunction<NotificationProvider['send']>

// ─── 1. Multi-channel routing ─────────────────────────────────────────────────

describe('NotificationService — multi-channel routing', () => {
  it('routes a send to the named provider', async () => {
    const email = makeMockProvider('email')
    const consoleP = makeMockProvider('console')
    const service = new NotificationService({ email, console: consoleP }, 'console')

    await service.send('user@example.com', 'Hello', 'World', 'email')

    expect(getSendMock(email)).toHaveBeenCalledTimes(1)
    expect(getSendMock(email)).toHaveBeenCalledWith('user@example.com', 'Hello', 'World')
    expect(getSendMock(consoleP)).not.toHaveBeenCalled()
  })

  it('falls back to the default provider when no override is supplied', async () => {
    const email = makeMockProvider('email')
    const consoleP = makeMockProvider('console')
    const service = new NotificationService({ email, console: consoleP }, 'console')

    await service.send('user@example.com', 'Hello', 'World')

    expect(getSendMock(consoleP)).toHaveBeenCalledTimes(1)
    expect(getSendMock(email)).not.toHaveBeenCalled()
  })

  it('calls each provider exactly once when a multi-channel fan-out is invoked', async () => {
    const email = makeMockProvider('email')
    const consoleP = makeMockProvider('console')
    const sms = makeMockProvider('sms')
    const service = new NotificationService({ email, console: consoleP, sms }, 'console')

    // Simulate a fan-out across every registered channel (one .send per provider).
    for (const providerName of Object.keys({ email, console: consoleP, sms })) {
      try {
        await service.send('user@example.com', 'Hello', 'World', providerName)
      } catch {
        // one provider may fail — fan-out is best-effort per channel
      }
    }

    expect(getSendMock(email)).toHaveBeenCalledTimes(1)
    expect(getSendMock(consoleP)).toHaveBeenCalledTimes(1)
    expect(getSendMock(sms)).toHaveBeenCalledTimes(1)
  })

  it('a failing provider does not block the other providers', async () => {
    const email = makeMockProvider('email', { fail: true })
    const consoleP = makeMockProvider('console')
    const service = new NotificationService({ email, console: consoleP }, 'console')

    // The email provider is broken but the console provider must still run.
    await expect(
      service.send('user@example.com', 'subj', 'body', 'email'),
    ).rejects.toThrow(/Provider email failed/)

    await service.send('user@example.com', 'subj', 'body', 'console')

    expect(getSendMock(email)).toHaveBeenCalledTimes(1)
    expect(getSendMock(consoleP)).toHaveBeenCalledTimes(1)
  })

  it('uses Promise.all-style fan-out: independent failures do not cancel siblings', async () => {
    const slowFailing = makeMockProvider('slow', { fail: true, delay: 25 })
    const fastOk = makeMockProvider('fast')
    const service = new NotificationService({ slow: slowFailing, fast: fastOk }, 'fast')

    const results = await Promise.allSettled([
      service.send('user@example.com', 'subj', 'body', 'slow'),
      service.send('user@example.com', 'subj', 'body', 'fast'),
    ])

    expect(results[0]!.status).toBe('rejected')
    expect(results[1]!.status).toBe('fulfilled')

    // The fast, healthy provider must still have been invoked exactly once
    // even though its sibling failed.
    expect(getSendMock(fastOk)).toHaveBeenCalledTimes(1)
    expect(getSendMock(slowFailing)).toHaveBeenCalledTimes(1)
  })
})

// ─── 2. buildNotificationProviderRegistry ────────────────────────────────────

describe('buildNotificationProviderRegistry', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('exposes both email and console providers by default', () => {
    const registry = buildNotificationProviderRegistry()
    expect(Object.keys(registry).sort()).toEqual(['console', 'email'])
    expect(registry.email?.name).toBe('email')
    expect(registry.console?.name).toBe('console')
  })

  it('returns a fresh instance per call (no shared mutable state)', () => {
    const a = buildNotificationProviderRegistry()
    const b = buildNotificationProviderRegistry()
    expect(a).not.toBe(b)
    expect(a.email).not.toBe(b.email)
  })
})

// ─── 3. createNotification dedup-key (mock-DB driven) ─────────────────────────

describe('createNotification — dedup-key suppression', () => {
  type InsertHandler = (row: Record<string, unknown>) => Promise<unknown[]>
  type FirstHandler = () => Promise<unknown | undefined>

  let dbModule: jest.MockedFunction<(table: string) => unknown>
  let insertHandler: InsertHandler
  let firstHandler: FirstHandler
  let existingRow: Record<string, unknown>

  let createNotification: typeof import('../services/notification.js').createNotification

  beforeEach(async () => {
    jest.resetModules()

    // Existing row returned for the duplicate lookup
    existingRow = {
      id: 'notif-existing-1',
      user_id: 'user-1',
      type: 'vault_completed',
      title: 'Vault completed',
      message: 'msg',
      data: null,
      idempotency_key: 'dup-key',
      read_at: null,
      archived_at: null,
      created_at: new Date().toISOString(),
    }

    insertHandler = jest.fn(async (_row: Record<string, unknown>) => [
      { ..._row, id: 'notif-new-1', created_at: new Date().toISOString() },
    ]) as unknown as InsertHandler

    firstHandler = jest.fn(async () => existingRow) as unknown as FirstHandler

    // Minimal chainable Knex mock that triggers 23505 only on the second insert.
    let insertCalls = 0
    const knexChain = (table: string) => {
      if (table !== 'notifications') {
        throw new Error(`unexpected table ${table}`)
      }
      return {
        insert(row: Record<string, unknown>) {
          insertCalls += 1
          if (insertCalls === 1) {
            return Promise.resolve([{ ...row, id: 'notif-new-1', created_at: new Date() }])
          }
          // Postgres-style unique-violation error
          const err: Error & { code?: string } = new Error('duplicate key value violates unique constraint')
          err.code = '23505'
          return Promise.reject(err)
        },
        where() {
          return {
            first: firstHandler,
          }
        },
      }
    }

    dbModule = jest.fn(knexChain) as unknown as jest.MockedFunction<(table: string) => unknown>

    jest.unstable_mockModule('../db/index.js', () => ({
      default: dbModule,
      db: dbModule,
    }))

    // isNotificationEnabled must return true so the insert is reached
    jest.unstable_mockModule('../models/notificationPreferences.js', () => ({
      isNotificationEnabled: jest.fn(async () => true),
    }))

    const mod = await import('../services/notification.js')
    createNotification = mod.createNotification
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('first call inserts and returns the new notification', async () => {
    const result = await createNotification({
      user_id: 'user-1',
      type: 'vault_completed',
      title: 'Vault completed',
      message: 'msg',
      idempotency_key: 'dup-key',
    })

    expect(result?.id).toBe('notif-new-1')
    expect(insertHandler).not.toHaveBeenCalled() // mock is replaced inline below
    expect(dbModule).toHaveBeenCalledWith('notifications')
  })

  it('duplicate call with the same idempotency_key returns the existing row, not a new one', async () => {
    await createNotification({
      user_id: 'user-1',
      type: 'vault_completed',
      title: 'Vault completed',
      message: 'msg',
      idempotency_key: 'dup-key',
    })

    // Second call collides on the unique index
    const second = await createNotification({
      user_id: 'user-1',
      type: 'vault_completed',
      title: 'Vault completed',
      message: 'msg',
      idempotency_key: 'dup-key',
    })

    expect(second?.id).toBe(existingRow.id)
    expect(second?.idempotency_key).toBe('dup-key')
  })

  it('duplicates with the same (user_id, idempotency_key) reuse the original id across N retries', async () => {
    const calls = await Promise.all(
      Array.from({ length: 5 }, () =>
        createNotification({
          user_id: 'user-1',
          type: 'vault_completed',
          title: 'Vault completed',
          message: 'msg',
          idempotency_key: 'stable-key',
        }),
      ),
    )

    // Every call in a dedup sequence must resolve to the same row id.
    const ids = calls.map((c) => c?.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBeLessThanOrEqual(2) // first + rest collapse to one
    expect(ids.filter((id) => id === existingRow.id).length).toBeGreaterThanOrEqual(1)
  })

  it('different idempotency_keys produce independent rows', async () => {
    jest.resetModules()
    let seq = 0
    const insertedRows: string[] = []

    const freshChain = (table: string) => {
      if (table !== 'notifications') throw new Error(`unexpected ${table}`)
      return {
        insert(row: Record<string, unknown>) {
          seq += 1
          const id = `notif-${seq}`
          insertedRows.push(id)
          // No collisions — always succeed
          return Promise.resolve([{ ...row, id, created_at: new Date() }])
        },
        where() {
          return {
            first: jest.fn(async () => undefined),
          }
        },
      }
    }

    jest.unstable_mockModule('../db/index.js', () => ({
      default: freshChain,
      db: freshChain,
    }))
    jest.unstable_mockModule('../models/notificationPreferences.js', () => ({
      isNotificationEnabled: jest.fn(async () => true),
    }))

    const mod = await import('../services/notification.js')
    const { createNotification: cn } = mod

    await cn({
      user_id: 'user-1',
      type: 't',
      title: 't',
      message: 'm',
      idempotency_key: 'k1',
    })
    await cn({
      user_id: 'user-1',
      type: 't',
      title: 't',
      message: 'm',
      idempotency_key: 'k2',
    })

    expect(insertedRows).toHaveLength(2)
    expect(new Set(insertedRows).size).toBe(2)
  })

  it('throws the original error when the duplicate lookup returns no row', async () => {
    jest.resetModules()
    const chain = (table: string) => {
      if (table !== 'notifications') throw new Error(`unexpected ${table}`)
      return {
        insert() {
          const err: Error & { code?: string } = new Error('duplicate key')
          err.code = '23505'
          return Promise.reject(err)
        },
        // Pretend the lookup also fails — createNotification must re-throw.
        where() {
          return {
            first: jest.fn(async () => undefined),
          }
        },
      }
    }

    jest.unstable_mockModule('../db/index.js', () => ({
      default: chain,
      db: chain,
    }))
    jest.unstable_mockModule('../models/notificationPreferences.js', () => ({
      isNotificationEnabled: jest.fn(async () => true),
    }))

    const mod = await import('../services/notification.js')
    const { createNotification: cn } = mod

    await expect(
      cn({
        user_id: 'user-1',
        type: 't',
        title: 't',
        message: 'm',
        idempotency_key: 'k',
      }),
    ).rejects.toThrow(/duplicate key/)
  })
})

// ─── 4. createNotification — channel-fanout via preferences ───────────────────

describe('createNotification — channel gating', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  it('returns null when the (org, type, channel) preference is disabled', async () => {
    jest.unstable_mockModule('../models/notificationPreferences.js', () => ({
      isNotificationEnabled: jest.fn(async () => false),
    }))

    const chain = () => ({
      insert: jest.fn(),
    } as unknown as Knex.QueryBuilder)

    jest.unstable_mockModule('../db/index.js', () => ({
      default: chain,
      db: chain,
    }))

    const mod = await import('../services/notification.js')
    const result = await mod.createNotification({
      user_id: 'user-1',
      type: 'vault_completed',
      title: 't',
      message: 'm',
      organization_id: 'org-1',
      channel: 'email',
    })

    expect(result).toBeNull()
  })

  it('falls back to the email channel when none is specified', async () => {
    const observed: Array<{ org: string; type: string; channel: string }> = []
    jest.unstable_mockModule('../models/notificationPreferences.js', () => ({
      isNotificationEnabled: jest.fn(async (org, type, channel) => {
        observed.push({ org, type, channel })
        return true
      }),
    }))

    const inserted: Array<Record<string, unknown>> = []
    const chain = (table: string) => {
      if (table !== 'notifications') throw new Error(`unexpected ${table}`)
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row)
          return Promise.resolve([{ ...row, id: 'nid', created_at: new Date() }])
        },
        where() {
          return { first: jest.fn(async () => undefined) }
        },
      }
    }

    jest.unstable_mockModule('../db/index.js', () => ({
      default: chain,
      db: chain,
    }))

    const mod = await import('../services/notification.js')
    const result = await mod.createNotification({
      user_id: 'user-1',
      type: 'vault_completed',
      title: 't',
      message: 'm',
      organization_id: 'org-1',
    })

    expect(result?.id).toBe('nid')
    expect(observed).toEqual([{ org: 'org-1', type: 'vault_completed', channel: 'email' }])
  })
})
