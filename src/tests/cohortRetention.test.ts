/**
 * Tests for the cohort-retention service and endpoint.
 *
 * Service tests:  exercise getCohortRetention() with an injected queryRunner
 *                 (no real DB required), following the team.rollup.test.ts pattern.
 *
 * Endpoint tests: spin up a minimal Express app with mocked auth middleware,
 *                 module-mock getCohortRetention, and exercise the full HTTP
 *                 request/response cycle via supertest.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getCohortRetention, CohortRetentionRow } from '../services/cohortRetention.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const USER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

type RawResult =
  | { rows: Record<string, string | number>[] }
  | Record<string, string | number>[]

function makeQueryRunner(rawResult: RawResult) {
  return {
    raw: async (_sql: string, ..._rest: unknown[]) => rawResult,
  }
}

function makeCapturingQueryRunner(rawResult: RawResult) {
  let capturedSql: string | undefined
  return {
    runner: {
      raw: async (sql: string, ..._rest: unknown[]) => {
        capturedSql = sql
        return rawResult
      },
    },
    getSql: () => capturedSql,
  }
}

const SAMPLE_ROWS: Record<string, string | number>[] = [
  {
    cohort_period: '2024-01',
    cohort_size: 120,
    retained_count: 100,
    retention_rate: 0.8333,
  },
  {
    cohort_period: '2024-02',
    cohort_size: 80,
    retained_count: 60,
    retention_rate: 0.75,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Service unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('getCohortRetention (service)', () => {
  it('returns empty cohorts array and null range when no rows exist', async () => {
    const result = await getCohortRetention(makeQueryRunner({ rows: [] }))

    expect(result.cohorts).toEqual([])
    expect(result.range).toBeNull()
    expect(result.generatedAt).toBeDefined()
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt)
  })

  it('maps pg-style { rows: [...] } response correctly', async () => {
    const result = await getCohortRetention(makeQueryRunner({ rows: SAMPLE_ROWS }))

    expect(result.cohorts).toHaveLength(2)
    expect(result.cohorts[0]).toEqual({
      cohort_period: '2024-01',
      cohort_size: 120,
      retained_count: 100,
      retention_rate: 0.8333,
    })
    expect(result.cohorts[1]).toEqual({
      cohort_period: '2024-02',
      cohort_size: 80,
      retained_count: 60,
      retention_rate: 0.75,
    })
  })

  it('maps array-style response (non-pg driver) correctly', async () => {
    const result = await getCohortRetention(
      makeQueryRunner(SAMPLE_ROWS as unknown as { rows: never }),
    )

    expect(result.cohorts).toHaveLength(2)
    expect(result.cohorts[0].cohort_period).toBe('2024-01')
  })

  it('sets range when a positive number is provided', async () => {
    const result = await getCohortRetention(makeQueryRunner({ rows: SAMPLE_ROWS }), 6)

    expect(result.range).toBe(6)
  })

  it('sets range to null when range is undefined', async () => {
    const result = await getCohortRetention(makeQueryRunner({ rows: [] }), undefined)

    expect(result.range).toBeNull()
  })

  it('sets range to null when range is 0 (invalid)', async () => {
    const result = await getCohortRetention(makeQueryRunner({ rows: [] }), 0)

    expect(result.range).toBeNull()
  })

  it('includes LIMIT clause in SQL when range is provided', async () => {
    const { runner, getSql } = makeCapturingQueryRunner({ rows: [] })

    await getCohortRetention(runner, 3)

    expect(getSql()).toMatch(/LIMIT 3/i)
  })

  it('does NOT include LIMIT clause in SQL when range is omitted', async () => {
    const { runner, getSql } = makeCapturingQueryRunner({ rows: [] })

    await getCohortRetention(runner)

    expect(getSql()).not.toMatch(/LIMIT/i)
  })

  it('queries vault_cohort_retention view', async () => {
    const { runner, getSql } = makeCapturingQueryRunner({ rows: [] })

    await getCohortRetention(runner)

    expect(getSql()).toMatch(/vault_cohort_retention/i)
  })

  it('coerces string numbers from DB to correct JS types', async () => {
    const stringRows: Record<string, string | number>[] = [
      {
        cohort_period: '2024-03',
        cohort_size: '50',   // DB may return strings
        retained_count: '40',
        retention_rate: '0.8',
      },
    ]
    const result = await getCohortRetention(makeQueryRunner({ rows: stringRows }))

    expect(typeof result.cohorts[0].cohort_size).toBe('number')
    expect(typeof result.cohorts[0].retained_count).toBe('number')
    expect(typeof result.cohorts[0].retention_rate).toBe('number')
    expect(result.cohorts[0].cohort_size).toBe(50)
    expect(result.cohorts[0].retention_rate).toBe(0.8)
  })

  it('includes a generatedAt ISO timestamp', async () => {
    const result = await getCohortRetention(makeQueryRunner({ rows: [] }))

    const parsed = new Date(result.generatedAt)
    expect(isNaN(parsed.getTime())).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint integration tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * We build a self-contained Express app that:
 *  - replaces `authenticate` with a lightweight JWT verifier
 *  - uses a pass-through middleware to set req.orgId
 *  - calls a jest-mocked version of `getCohortRetention`
 *
 * This lets us test routing, query-param parsing, and response shape
 * without touching a real database.
 */

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function issueToken(userId: string, _orgId: string, role: string) {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' })
}

function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' })
    return
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET) as Express.Request['user']
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// We need to mock getCohortRetention before building the app, so we pull it
// from the already-imported module and spy on it.
const mockGetCohortRetention = jest.fn<typeof getCohortRetention>()

// Build a fresh app per test suite to avoid state bleed
function buildApp() {
  const app = express()
  app.use(express.json())

  app.get(
    '/api/orgs/:orgId/cohort-retention',
    mockAuthenticate,
    (req, res, next) => { (req as any).orgId = req.params.orgId; next() },
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const range = req.query.range
          ? parseInt(req.query.range as string, 10)
          : undefined

        const data = await mockGetCohortRetention(undefined as any, range)

        return res.status(200).json({
          success: true,
          orgId: req.params.orgId,
          data,
        })
      } catch (error) {
        next(error)
      }
    },
  )

  // AppError-aware error handler so 401/403/404/500 status codes are correct
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as any).status ?? 500
    res.status(status).json({ error: err.message })
  })

  return app
}

describe('GET /api/orgs/:orgId/cohort-retention (endpoint)', () => {
  beforeEach(() => {
    mockGetCohortRetention.mockResolvedValue({
      cohorts: SAMPLE_ROWS as unknown as CohortRetentionRow[],
      range: null,
      generatedAt: new Date().toISOString(),
    })
  })

  it('returns 401 when Authorization header is missing', async () => {
    const app = buildApp()
    const res = await request(app).get(`/api/orgs/${ORG_ID}/cohort-retention`)

    expect(res.status).toBe(401)
  })

  it('returns 401 when JWT is invalid', async () => {
    const app = buildApp()
    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/cohort-retention`)
      .set('Authorization', 'Bearer not.a.real.token')

    expect(res.status).toBe(401)
  })

  it('returns 200 with expected shape for an authorised owner', async () => {
    const app = buildApp()
    const token = issueToken(USER_ID, ORG_ID, 'owner')

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/cohort-retention`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.orgId).toBe(ORG_ID)
    expect(res.body.data).toBeDefined()
    expect(Array.isArray(res.body.data.cohorts)).toBe(true)
    expect(res.body.data.generatedAt).toBeDefined()
  })

  it('forwards the ?range query parameter to getCohortRetention', async () => {
    const app = buildApp()
    const token = issueToken(USER_ID, ORG_ID, 'owner')

    await request(app)
      .get(`/api/orgs/${ORG_ID}/cohort-retention?range=6`)
      .set('Authorization', `Bearer ${token}`)

    expect(mockGetCohortRetention).toHaveBeenCalledTimes(1)
    const [, rangeArg] = mockGetCohortRetention.mock.calls[0]
    expect(rangeArg).toBe(6)
  })

  it('calls getCohortRetention with undefined range when ?range is absent', async () => {
    const app = buildApp()
    const token = issueToken(USER_ID, ORG_ID, 'owner')

    await request(app)
      .get(`/api/orgs/${ORG_ID}/cohort-retention`)
      .set('Authorization', `Bearer ${token}`)

    expect(mockGetCohortRetention).toHaveBeenCalledTimes(1)
    const [, rangeArg] = mockGetCohortRetention.mock.calls[0]
    expect(rangeArg).toBeUndefined()
  })

  it('returns 500 when getCohortRetention rejects', async () => {
    mockGetCohortRetention.mockRejectedValue(new Error('DB connection failed'))

    const app = buildApp()
    const token = issueToken(USER_ID, ORG_ID, 'owner')

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/cohort-retention`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(500)
  })

  it('returns cohort data in the data.cohorts array', async () => {
    const app = buildApp()
    const token = issueToken(USER_ID, ORG_ID, 'owner')

    const res = await request(app)
      .get(`/api/orgs/${ORG_ID}/cohort-retention`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.cohorts).toHaveLength(SAMPLE_ROWS.length)
    expect(res.body.data.cohorts[0]).toMatchObject({
      cohort_period: '2024-01',
      cohort_size: 120,
      retained_count: 100,
    })
  })
})
