/**
 * requireOrgRole / requireTeamRole must not disguise infrastructure failures
 * as ordinary 403 Forbidden responses (see #1268).
 */

process.env.DOWNLOAD_SECRET =
  process.env.DOWNLOAD_SECRET || 'test-download-secret-for-orgauth-db-errors'

import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import type { NextFunction, Request, Response } from 'express'

// The middleware proves the target org/team exists (returns 404 otherwise)
// before checking membership, so the DB mock must answer those lookups with a
// real row while letting the membership lookup vary per test.
const mockFirst = jest.fn<() => Promise<unknown>>()
const mockWhere = jest.fn(() => ({ first: mockFirst }))
const mockDb = jest.fn((table: string) => ({
  where: () => ({ first: () => promiseForTable(table) }),
}))

/**
 * `organizations`/`teams` lookups always resolve to an existing row; the
 * membership tables honor whatever `mockFirst` was configured to resolve.
 */
function promiseForTable(table: string): Promise<unknown> {
  if (table === 'organizations' || table === 'teams') {
    return Promise.resolve({ id: table === 'organizations' ? 'org-1' : 'team-1' })
  }
  return mockFirst()
}

jest.unstable_mockModule('../db/index.js', () => ({
  default: mockDb,
}))

jest.unstable_mockModule('../lib/prismaScope.js', () => ({
  getPrisma: () => ({
    organization: {
      findUnique: async (args: any) => {
        return mockDb('organizations').where({ id: args.where.id }).first()
      }
    },
    membership: {
      findFirst: async (args: any) => {
        const tbl = args.where.teamId ? 'team_members' : 'org_members'
        return mockDb(tbl).where().first()
      }
    },
    team: {
      findUnique: async (args: any) => {
        return mockDb('teams').where({ id: args.where.id }).first()
      }
    }
  }),
  prismaStorage: {
    getStore: () => undefined,
    run: (ctx: any, cb: any) => cb()
  }
}))

jest.unstable_mockModule('../models/organizations.js', () => ({
  getOrganization: jest.fn(),
  getMemberRole: jest.fn(),
}))

// loadModuleGuard prevents TS from tree-shaking the import; the mock above
// ensures getOrganization/getMemberRole are never actually called.

const { requireOrgRole, requireTeamRole } = await import('../middleware/orgAuth.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

function buildOrgApp() {
  const app = express()
  app.get(
    '/orgs/:orgId/secure',
    (req: Request, _res: Response, next: NextFunction) => {
      ;(req as any).user = { userId: 'user-1' }
      next()
    },
    requireOrgRole(['owner', 'admin']),
    (_req, res) => {
      res.status(200).json({ ok: true })
    },
  )
  app.use(errorHandler)
  return app
}

function buildTeamApp() {
  const app = express()
  app.get(
    '/teams/:teamId/secure',
    (req: Request, _res: Response, next: NextFunction) => {
      ;(req as any).user = { userId: 'user-1' }
      next()
    },
    requireTeamRole(['owner', 'admin']),
    (_req, res) => {
      res.status(200).json({ ok: true })
    },
  )
  app.use(errorHandler)
  return app
}

describe('requireOrgRole / requireTeamRole DB error handling', () => {
  beforeEach(() => {
    mockFirst.mockReset()
    mockWhere.mockClear()
    mockDb.mockClear()
  })

  it('returns 403 when org membership is missing (no-row, not an exception)', async () => {
    // requireOrgRole first proves the org exists (first query), then looks up
    // membership (second query) — the missing row is the membership, not the org.
    mockFirst
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValue(undefined)

    const res = await request(buildOrgApp()).get('/orgs/org-1/secure')

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires organization role/i)
    expect(mockDb).toHaveBeenCalledWith('org_members')
  })

  it('returns 403 when org membership role is insufficient', async () => {
    mockFirst.mockResolvedValue({ role: 'member' })

    const res = await request(buildOrgApp()).get('/orgs/org-1/secure')

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires organization role/i)
  })

  it('allows the request when org membership role matches', async () => {
    mockFirst.mockResolvedValue({ role: 'admin' })

    const res = await request(buildOrgApp()).get('/orgs/org-1/secure')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('propagates unexpected org_members DB errors as 500 (not 403)', async () => {
    mockFirst.mockRejectedValue(new Error('connection refused'))

    const res = await request(buildOrgApp()).get('/orgs/org-1/secure')

    expect(res.status).toBe(500)
    expect(res.body.error?.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(res.body)).not.toMatch(/requires organization role/i)
  })

  it('returns 403 when team membership is missing (no-row, not an exception)', async () => {
    // requireTeamRole first proves the team exists (first query), then looks up
    // membership (second query) — the missing row is the membership, not the team.
    mockFirst
      .mockResolvedValueOnce({ id: 'team-1' })
      .mockResolvedValue(undefined)

    const res = await request(buildTeamApp()).get('/teams/team-1/secure')

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires team role/i)
    expect(mockDb).toHaveBeenCalledWith('team_members')
  })

  it('propagates unexpected team_members DB errors as 500 (not 403)', async () => {
    mockFirst.mockRejectedValue(new Error('timeout querying team_members'))

    const res = await request(buildTeamApp()).get('/teams/team-1/secure')

    expect(res.status).toBe(500)
    expect(res.body.error?.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(res.body)).not.toMatch(/requires team role/i)
  })
})
