import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'

const mockGetPrisma = jest.fn<any>()
const mockIdempotencyService = {
  getIdempotentResponse: jest.fn<any>(),
  saveIdempotentResponse: jest.fn<any>(),
  failPendingIdempotentResponse: jest.fn<any>(),
}

const mockDbQuery = {
  where: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  toSQL: () => ({
    toNative: () => ({ sql: 'SELECT * FROM vaults WHERE organization_id = $1 AND deleted_at IS NULL', bindings: ['org-1'] })
  })
}

// Mock database connection
jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn(() => mockDbQuery)
}))

// Mock prismaScope
jest.unstable_mockModule('../lib/prismaScope.js', () => ({
  getPrisma: mockGetPrisma,
  prismaStorage: {
    getStore: () => ({ prisma: mockGetPrisma(), orgId: 'org-1' }),
    run: (ctx: any, cb: any) => cb()
  }
}))

// Mock idempotency
jest.unstable_mockModule('../services/idempotency.js', () => ({
  validateIdempotencyKey: () => ({ valid: true }),
  scopeIdempotencyKey: (userId: string, key: string) => `${userId}:${key}`,
  hashRequestPayload: () => 'payload-hash',
  getIdempotentResponse: mockIdempotencyService.getIdempotentResponse,
  saveIdempotentResponse: mockIdempotencyService.saveIdempotentResponse,
  failPendingIdempotentResponse: mockIdempotencyService.failPendingIdempotentResponse,
  IdempotencyConflictError: class extends Error {
    constructor() {
      super('Idempotency key conflict')
      this.name = 'IdempotencyConflictError'
    }
  }
}))

// Mock rate limiters and auth
jest.unstable_mockModule('../middleware/rateLimiter.js', () => ({
  orgReadRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  orgWriteRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.unstable_mockModule('../middleware/queryParser.js', () => ({
  queryParser: () => (req: Request, _res: Response, next: NextFunction) => {
    (req as any).pagination = { page: 1, pageSize: 20 };
    next();
  }
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { userId: 'user-123' } as any
    next()
  }
}))

jest.unstable_mockModule('../middleware/orgAuth.js', () => ({
  requireOrgAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

const { orgVaultsRouter } = await import('../routes/orgVaults.js')

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/orgs', orgVaultsRouter)
  return app
}

describe('orgVaults Router — Prisma Scoping, Invariants, and Idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIdempotencyService.getIdempotentResponse.mockReset()
    mockIdempotencyService.saveIdempotentResponse.mockReset()
    mockIdempotencyService.failPendingIdempotentResponse.mockReset()
  })

  describe('GET /api/orgs/:orgId/vaults', () => {
    it('uses $queryRawUnsafe to fetch vaults inside the request-scoped context', async () => {
      const mockVaults = [
        {
          id: 'v-1',
          creator: 'user-1',
          verifier: 'v-addr',
          amount: '100',
          status: 'active',
          organization_id: 'org-1',
          start_date: new Date().toISOString(),
          end_date: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      ]

      mockGetPrisma.mockReturnValue({
        $queryRawUnsafe: jest.fn().mockResolvedValue(mockVaults)
      })

      const res = await request(buildApp()).get('/api/orgs/org-1/vaults')

      expect(res.status).toBe(200)
      expect(res.body.data[0].id).toBe('v-1')
      expect(res.body.data[0].orgId).toBe('org-1')
    })
  })

  describe('POST /api/orgs/:orgId/vault-searches', () => {
    it('enforces idempotency and returns cached response if key matches', async () => {
      const cachedResponse = { search: { id: 'search-123', name: 'Cached Search' } }
      mockIdempotencyService.getIdempotentResponse.mockResolvedValue(cachedResponse)

      const res = await request(buildApp())
        .post('/api/orgs/org-1/vault-searches')
        .set('idempotency-key', 'idem-key-123')
        .send({ name: 'My Search', query_definition: { status: 'active' } })

      expect(res.status).toBe(200)
      expect(res.body).toEqual(cachedResponse)
      expect(mockIdempotencyService.getIdempotentResponse).toHaveBeenCalled()
    })

    it('enforces limit check (MAX_SEARCHES_PER_ORG) and creates search atomically', async () => {
      mockIdempotencyService.getIdempotentResponse.mockResolvedValue(null)

      const mockSearchRecord = {
        id: 'search-1',
        orgId: 'org-1',
        name: 'My Search',
        queryDefinition: { status: 'active' },
        alertsEnabled: false,
        alertRecipient: null,
        alertFrequencyMs: 3600000,
        lastEvaluatedAt: null,
        lastResultHash: null,
        createdBy: 'user-123',
        createdAt: new Date(),
        updatedAt: new Date()
      }

      mockGetPrisma.mockReturnValue({
        $transaction: async (cb: any) => {
          const tx = {
            orgVaultSearch: {
              count: jest.fn().mockResolvedValue(5), // count is less than 20
              create: jest.fn().mockResolvedValue(mockSearchRecord)
            }
          }
          return cb(tx)
        }
      })

      const res = await request(buildApp())
        .post('/api/orgs/org-1/vault-searches')
        .send({ name: 'My Search', query_definition: { status: 'active' } })

      expect(res.status).toBe(201)
      expect(res.body.search.id).toBe('search-1')
    })

    it('returns 422 if the org has reached the maximum number of saved searches', async () => {
      mockIdempotencyService.getIdempotentResponse.mockResolvedValue(null)

      mockGetPrisma.mockReturnValue({
        $transaction: async (cb: any) => {
          const tx = {
            orgVaultSearch: {
              count: jest.fn().mockResolvedValue(20), // Max limit reached
              create: jest.fn()
            }
          }
          return cb(tx)
        }
      })

      const res = await request(buildApp())
        .post('/api/orgs/org-1/vault-searches')
        .send({ name: 'My Search', query_definition: { status: 'active' } })

      expect(res.status).toBe(422)
      expect(res.body.error).toContain('maximum of 20 saved searches')
    })

    it('calls failPendingIdempotentResponse on transaction failure to recover state', async () => {
      mockIdempotencyService.getIdempotentResponse.mockResolvedValue(null)

      mockGetPrisma.mockReturnValue({
        $transaction: jest.fn().mockRejectedValue(new Error('DB failure'))
      })

      const res = await request(buildApp())
        .post('/api/orgs/org-1/vault-searches')
        .set('idempotency-key', 'idem-key-error')
        .send({ name: 'My Search', query_definition: { status: 'active' } })

      expect(res.status).toBe(500)
      expect(mockIdempotencyService.failPendingIdempotentResponse).toHaveBeenCalled()
    })
  })
})
