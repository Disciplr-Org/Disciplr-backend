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

const mockFirst = jest.fn<() => Promise<unknown>>()
const mockWhere = jest.fn(() => ({ first: mockFirst }))
const mockDb = jest.fn(() => ({ where: mockWhere }))

jest.unstable_mockModule('../db/index.js', () => ({
  default: mockDb,
}))

jest.unstable_mockModule('../models/organizations.js', () => ({
  getOrganization: jest.fn(),
  getMemberRole: jest.fn(),
}))

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
    mockFirst.mockResolvedValue(undefined)

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
    mockFirst.mockResolvedValue(undefined)

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
