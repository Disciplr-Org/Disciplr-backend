import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'

// ── In-memory db mock ───────────────────────────────────────────────────────

let store: Record<string, unknown>[] = []

function matches(row: Record<string, unknown>, filters: Record<string, unknown>, whereIns: Record<string, unknown[]>) {
  return (
    Object.entries(filters).every(([k, v]) => row[k] === v) &&
    Object.entries(whereIns).every(([k, v]) => (v as unknown[]).includes(row[k]))
  )
}

function pick(row: Record<string, unknown>, cols: string[]) {
  if (cols.length === 0) return { ...row }
  const out: Record<string, unknown> = {}
  for (const c of cols) out[c] = row[c]
  return out
}

const dbMock: any = jest.fn((_table: string) => {
  const filters: Record<string, unknown> = {}
  const whereIns: Record<string, unknown[]> = {}
  let insertRows: Record<string, unknown>[] = []
  let conflictCols: string[] = []

  const qb: any = {
    where: jest.fn((cond: Record<string, unknown>) => {
      Object.assign(filters, cond)
      return qb
    }),
    whereIn: jest.fn((col: string, vals: unknown[]) => {
      whereIns[col] = vals
      return qb
    }),
    select: jest.fn((...cols: string[]) => {
      const rows = store.filter((r) => matches(r, filters, whereIns))
      return Promise.resolve(rows.map((r) => pick(r, cols)))
    }),
    insert: jest.fn((rows: Record<string, unknown>[]) => {
      insertRows = rows
      return qb
    }),
    onConflict: jest.fn((cols: string[]) => {
      conflictCols = cols
      return qb
    }),
    merge: jest.fn(() => {
      for (const row of insertRows) {
        const idx = store.findIndex((r) => conflictCols.every((c) => r[c] === row[c]))
        if (idx >= 0) {
          store[idx] = { ...store[idx], ...row }
        } else {
          store.push({ ...row })
        }
      }
      return Promise.resolve()
    }),
  }
  return qb
})

jest.unstable_mockModule('../db/index.js', async () => ({ default: dbMock }))

jest.unstable_mockModule('../middleware/auth.js', async () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../middleware/orgAuth.js', async () => ({
  requireOrgAccess: (..._roles: string[]) => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

// Must import after mocks are registered.
const { notificationPreferencesRouter } = await import('../routes/notificationPreferences.js')
const { errorHandler } = await import('../middleware/errorHandler.js')
const { isNotificationEnabled } = await import('../models/notificationPreferences.js')

const app = express()
app.use(express.json())
app.use('/api/orgs', notificationPreferencesRouter)
app.use(errorHandler)

const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  store = []
  jest.clearAllMocks()
})

describe('GET /api/orgs/:orgId/notification-preferences', () => {
  it('defaults to all-enabled when no preferences are stored', async () => {
    const res = await request(app).get(`/api/orgs/${ORG_A}/notification-preferences`)

    expect(res.status).toBe(200)
    expect(res.body.categories).toEqual({ vault_failure: true, milestone_reminder: true })
    expect(res.body.channels).toEqual({ email: true })
  })
})

describe('PUT /api/orgs/:orgId/notification-preferences', () => {
  it('disables a category and persists the change', async () => {
    const res = await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ categories: { milestone_reminder: false } })

    expect(res.status).toBe(200)
    expect(res.body.categories.milestone_reminder).toBe(false)
    expect(res.body.categories.vault_failure).toBe(true)
  })

  it('opts a channel out entirely', async () => {
    const res = await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ channels: { email: false } })

    expect(res.status).toBe(200)
    expect(res.body.channels.email).toBe(false)
  })

  it('rejects an unknown category', async () => {
    const res = await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ categories: { not_a_real_category: false } })

    expect(res.status).toBe(400)
  })

  it('rejects an unknown channel', async () => {
    const res = await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ channels: { sms: false } })

    expect(res.status).toBe(400)
  })
})

describe('isNotificationEnabled (dispatch-path check)', () => {
  it('defaults to enabled with no preferences', async () => {
    await expect(isNotificationEnabled(ORG_A, 'vault_failure')).resolves.toBe(true)
  })

  it('suppresses a disabled category', async () => {
    await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ categories: { vault_failure: false } })

    await expect(isNotificationEnabled(ORG_A, 'vault_failure')).resolves.toBe(false)
    await expect(isNotificationEnabled(ORG_A, 'milestone_reminder')).resolves.toBe(true)
  })

  it('suppresses every category once the channel is opted out', async () => {
    await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ channels: { email: false } })

    await expect(isNotificationEnabled(ORG_A, 'vault_failure')).resolves.toBe(false)
    await expect(isNotificationEnabled(ORG_A, 'milestone_reminder')).resolves.toBe(false)
  })

  it('lets a category-specific override win over a channel opt-out', async () => {
    await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ channels: { email: false }, categories: { vault_failure: true } })

    await expect(isNotificationEnabled(ORG_A, 'vault_failure')).resolves.toBe(true)
    await expect(isNotificationEnabled(ORG_A, 'milestone_reminder')).resolves.toBe(false)
  })

  it('returns true when no organization is supplied', async () => {
    await expect(isNotificationEnabled(undefined, 'vault_failure')).resolves.toBe(true)
  })

  it('isolates preferences between organizations', async () => {
    await request(app)
      .put(`/api/orgs/${ORG_A}/notification-preferences`)
      .send({ categories: { vault_failure: false } })

    await expect(isNotificationEnabled(ORG_A, 'vault_failure')).resolves.toBe(false)
    await expect(isNotificationEnabled(ORG_B, 'vault_failure')).resolves.toBe(true)

    const resB = await request(app).get(`/api/orgs/${ORG_B}/notification-preferences`)
    expect(resB.body.categories.vault_failure).toBe(true)
  })
})
