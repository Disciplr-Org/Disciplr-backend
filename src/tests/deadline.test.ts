import { beforeEach, describe, expect, it, jest } from '@jest/globals'

type VaultRow = {
  id: string
  creator: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  end_date: string
}

type NotificationRow = {
  user_id: string
  type: string
  data?: Record<string, unknown>
}

const fixedNow = new Date('2026-04-25T12:00:00.000Z')
const vaultRows: VaultRow[] = []
const notificationRows: NotificationRow[] = []
let failNextVaultUpdate = false

const makeVault = (overrides: Partial<VaultRow> = {}): VaultRow => ({
  id: `vault-${vaultRows.length + 1}`,
  creator: `user-${vaultRows.length + 1}`,
  status: 'active',
  end_date: fixedNow.toISOString(),
  ...overrides,
})

function makeDb() {
  const db: any = (tableName: string) => makeQuery(tableName)
  return db
}

function makeQuery(tableName: string) {
  const predicates: Array<(row: any) => boolean> = []
  let updatePayload: Record<string, unknown> | undefined
  let insertPayload: any
  let rowLimit: number | undefined

  const query: any = {
    where(columnOrObject: string | Record<string, unknown>, operator?: string, value?: unknown) {
      if (typeof columnOrObject === 'object') {
        for (const [key, expected] of Object.entries(columnOrObject)) {
          predicates.push((row) => row[key] === expected)
        }
        return query
      }

      if (arguments.length === 2) {
        predicates.push((row) => row[columnOrObject] === operator)
        return query
      }

      predicates.push((row) => compare(row[columnOrObject], String(operator), value))
      return query
    },
    andWhere(column: string, operator: string, value: unknown) {
      predicates.push((row) => compare(row[column], operator, value))
      return query
    },
    whereIn(column: string, values: unknown[]) {
      predicates.push((row) => values.includes(row[column]))
      return query
    },
    select() {
      if (tableName !== 'vaults') return []
      const rows = vaultRows.filter((row) => predicates.every((predicate) => predicate(row)))
      return typeof rowLimit === 'number' ? rows.slice(0, rowLimit) : rows
    },
    limit(limit: number) {
      rowLimit = limit
      return query
    },
    update(payload: Record<string, unknown>) {
      updatePayload = payload
      if (tableName !== 'vaults') return query

      const updated = vaultRows.filter((row) => predicates.every((predicate) => predicate(row)))
      if (failNextVaultUpdate) {
        failNextVaultUpdate = false
        throw new Error('db update failed')
      }
      for (const row of updated) {
        Object.assign(row, updatePayload)
      }
      return Promise.resolve(updated.length)
    },
    insert(payload: any) {
      insertPayload = payload
      return query
    },
    async returning() {
      if (tableName === 'notifications') {
        notificationRows.push(insertPayload)
        return [{ id: `notification-${notificationRows.length}`, ...insertPayload }]
      }

      if (tableName === 'vaults' && updatePayload) {
        const updated = vaultRows.filter((row) => predicates.every((predicate) => predicate(row)))
        return updated
      }

      return []
    },
  }

  return query
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
  const actualTime = new Date(String(actual)).getTime()
  const expectedTime = new Date(String(expected)).getTime()

  if (operator === '<=') return actualTime <= expectedTime
  if (operator === '<') return actualTime < expectedTime
  if (operator === '>') return actualTime > expectedTime
  if (operator === '=') return actual === expected
  return false
}

const db = makeDb()

jest.unstable_mockModule('../db/index.js', () => ({
  db,
  default: db,
}))

const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

const { markVaultExpiries } = await import('../services/vault.js')
const { processExpiredVaultsBatch, startExpirationChecker, stopExpirationChecker } = await import('../services/expirationScheduler.js')
const { defaultJobHandlers } = await import('../jobs/handlers.js')

describe('deadline expiration correctness', () => {
  beforeEach(() => {
    vaultRows.length = 0
    notificationRows.length = 0
    failNextVaultUpdate = false
    consoleLogSpy.mockClear()
    consoleErrorSpy.mockClear()
    stopExpirationChecker()
    jest.useRealTimers()
  })

  it('does not expire just before the UTC deadline', async () => {
    const vault = makeVault({ end_date: new Date(fixedNow.getTime() + 1).toISOString() })
    vaultRows.push(vault)

    await expect(markVaultExpiries({ now: fixedNow })).resolves.toBe(0)
    expect(vault.status).toBe('active')
    expect(notificationRows).toHaveLength(0)
  })

  it('expires exactly at the UTC deadline', async () => {
    const vault = makeVault({ end_date: fixedNow.toISOString() })
    vaultRows.push(vault)

    await expect(markVaultExpiries({ now: fixedNow })).resolves.toBe(1)
    expect(vault.status).toBe('failed')
    expect(notificationRows).toHaveLength(1)
    expect(notificationRows[0]).toMatchObject({
      user_id: vault.creator,
      type: 'vault_failure',
      data: { vaultId: vault.id },
    })
  })

  it('expires exactly at the UTC deadline with offset input', async () => {
    const vault = makeVault({ end_date: '2026-04-25T08:00:00-04:00' })
    vaultRows.push(vault)

    await expect(markVaultExpiries({ now: fixedNow })).resolves.toBe(1)
    expect(vault.status).toBe('failed')
  })

  it('expires just after the UTC deadline including offset timestamp inputs', async () => {
    const vault = makeVault({ end_date: '2026-04-25T07:59:59.999-04:00' })
    vaultRows.push(vault)

    await expect(markVaultExpiries({ now: fixedNow })).resolves.toBe(1)
    expect(vault.status).toBe('failed')
  })

  it('does not duplicate transitions or notifications on repeated runs', async () => {
    const vault = makeVault({ end_date: fixedNow.toISOString() })
    vaultRows.push(vault)

    await expect(markVaultExpiries({ now: fixedNow })).resolves.toBe(1)
    await expect(markVaultExpiries({ now: fixedNow })).resolves.toBe(0)

    expect(vault.status).toBe('failed')
    expect(notificationRows).toHaveLength(1)
  })

  it('deadline.check performs expiration work and logs the expired count', async () => {
    vaultRows.push(makeVault({ end_date: fixedNow.toISOString() }))
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)

    const promise = defaultJobHandlers['deadline.check'](
      { triggerSource: 'scheduler', deadlineIso: fixedNow.toISOString() },
      { jobId: 'job-1', attempt: 1 },
    )
    await jest.advanceTimersByTimeAsync(30)
    await promise

    expect(vaultRows[0].status).toBe('failed')
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('expired=1 source=scheduler attempt=1'),
    )
    jest.useRealTimers()
  })

  it('deadline.check propagates DB failures for queue retry', async () => {
    vaultRows.push(makeVault({ end_date: fixedNow.toISOString() }))
    failNextVaultUpdate = true
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)

    const promise = defaultJobHandlers['deadline.check'](
      { triggerSource: 'scheduler' },
      { jobId: 'job-2', attempt: 1 },
    )
    const assertion = expect(promise).rejects.toThrow('db update failed')
    await jest.advanceTimersByTimeAsync(30)
    await assertion
    jest.useRealTimers()
  })

  it('scheduler batch uses shared expiration logic and remains idempotent', async () => {
    vaultRows.push(makeVault({ end_date: fixedNow.toISOString() }))
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)

    await expect(processExpiredVaultsBatch()).resolves.toBe(1)
    await expect(processExpiredVaultsBatch()).resolves.toBe(0)

    expect(vaultRows[0].status).toBe('failed')
    expect(notificationRows).toHaveLength(1)
    expect(consoleLogSpy).toHaveBeenCalledWith('[ExpirationChecker] Failed 1 expired vault(s)')
    jest.useRealTimers()
  })

  it('scheduler batch preserves the 50-vault tick limit', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)
    for (let index = 0; index < 51; index += 1) {
      vaultRows.push(makeVault({ id: `vault-${index}`, creator: `user-${index}` }))
    }

    await expect(processExpiredVaultsBatch()).resolves.toBe(50)
    expect(vaultRows.filter((vault) => vault.status === 'failed')).toHaveLength(50)
    expect(notificationRows).toHaveLength(50)

    await expect(processExpiredVaultsBatch()).resolves.toBe(1)
    expect(vaultRows.filter((vault) => vault.status === 'failed')).toHaveLength(51)
    expect(notificationRows).toHaveLength(51)
    jest.useRealTimers()
  })

  it('deadline.check processes all expired active vaults', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)
    for (let index = 0; index < 51; index += 1) {
      vaultRows.push(makeVault({ id: `vault-${index}`, creator: `user-${index}` }))
    }

    const promise = defaultJobHandlers['deadline.check'](
      { triggerSource: 'manual', deadlineIso: fixedNow.toISOString() },
      { jobId: 'job-3', attempt: 1 },
    )
    await jest.advanceTimersByTimeAsync(30)
    await promise

    expect(vaultRows.filter((vault) => vault.status === 'failed')).toHaveLength(51)
    expect(notificationRows).toHaveLength(51)
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('expired=51 source=manual attempt=1'),
    )
    jest.useRealTimers()
  })

  it('startExpirationChecker runs immediately and on interval without duplicate transitions', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)
    vaultRows.push(makeVault({ end_date: fixedNow.toISOString() }))

    startExpirationChecker(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(vaultRows[0].status).toBe('failed')
    expect(notificationRows).toHaveLength(1)

    await jest.advanceTimersByTimeAsync(1_000)

    expect(vaultRows[0].status).toBe('failed')
    expect(notificationRows).toHaveLength(1)

    stopExpirationChecker()
    jest.useRealTimers()
  })

  it('startExpirationChecker logs failed checks and ignores duplicate starts', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)
    vaultRows.push(makeVault({ end_date: fixedNow.toISOString() }))
    failNextVaultUpdate = true

    startExpirationChecker(1_000)
    startExpirationChecker(1_000)
    await jest.advanceTimersByTimeAsync(0)

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[ExpirationChecker] Check failed:',
      expect.any(Error),
    )

    await jest.advanceTimersByTimeAsync(1_000)

    expect(vaultRows[0].status).toBe('failed')
    expect(notificationRows).toHaveLength(1)

    stopExpirationChecker()
    jest.useRealTimers()
  })

  it('startExpirationChecker uses the default interval when none is provided', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(fixedNow)

    startExpirationChecker()
    await jest.advanceTimersByTimeAsync(0)

    expect(consoleErrorSpy).not.toHaveBeenCalled()

    stopExpirationChecker()
    jest.useRealTimers()
  })
})
