// src/tests/orgAuth.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import type { Request, NextFunction } from 'express'

// Handles defined before the mocks so the factories can close over them.
const mockGetAuthenticatedUserId = jest.fn<() => string | null>()
const mockDb = jest.fn()

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

jest.unstable_mockModule('../middleware/auth.js', () => ({
  getAuthenticatedUserId: mockGetAuthenticatedUserId,
}))

const { requireOrgAccess } = await import('../middleware/orgAuth.js')
const { AppError } = await import('../middleware/errorHandler.js')
const db = (await import('../db/index.js')).default;
const { getAuthenticatedUserId } = await import('../middleware/auth.js');

describe('requireOrgAccess middleware', () => {
  const mockNext = jest.fn() as unknown as NextFunction

  beforeEach(() => {
    mockGetAuthenticatedUserId.mockReset()
    mockDb.mockReset()
    mockNext.mockReset()
  })

  it('passes when org exists and user is a member with allowed role', async () => {
    const req = {
      params: { orgId: 'org-123' },
      query: {},
    } as unknown as Request;
    mockGetAuthenticatedUserId.mockReturnValue('user-1')
    mockDb.mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve({ id: 'org-123' }) }) }
      }
      if (table === 'org_members') {
        return {
          where: () => ({ first: () => Promise.resolve({ role: 'admin' }) }),
        }
      }
      return {}
    })

    const middleware = requireOrgAccess('admin', 'member')
    await middleware(req, {} as any, mockNext)
    expect(mockNext).toHaveBeenCalledTimes(1)
    expect(mockNext).toHaveBeenCalledWith()
  })

  it('returns 401 when orgId or userId missing', async () => {
    const req = { params: {}, query: {} } as unknown as Request
    mockGetAuthenticatedUserId.mockReturnValue(null)
    const middleware = requireOrgAccess('admin')
    await middleware(req, {} as any, mockNext)
    expect(mockNext).toHaveBeenCalledTimes(1)
    const err = mockNext.mock.calls[0]?.[0] as unknown
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).status).toBe(401)
  })

  it('returns 404 when organization not found', async () => {
    const req = { params: { orgId: 'missing' }, query: {} } as unknown as Request
    mockGetAuthenticatedUserId.mockReturnValue('user-1')
    mockDb.mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve(undefined) }) }
      }
      return {}
    })
    const middleware = requireOrgAccess('admin')
    await middleware(req, {} as any, mockNext)
    expect(mockNext).toHaveBeenCalledTimes(1)
    const err = mockNext.mock.calls[0]?.[0] as unknown
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).status).toBe(404)
  })

  it('returns 403 when membership missing', async () => {
    const req = { params: { orgId: 'org-123' }, query: {} } as unknown as Request
    mockGetAuthenticatedUserId.mockReturnValue('user-1')
    mockDb.mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve({ id: 'org-123' }) }) }
      }
      if (table === 'org_members') {
        return { where: () => ({ first: () => Promise.resolve(undefined) }) }
      }
      return {}
    })
    const middleware = requireOrgAccess('admin')
    await middleware(req, {} as any, mockNext)
    expect(mockNext).toHaveBeenCalledTimes(1)
    const err = mockNext.mock.calls[0]?.[0] as unknown
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).status).toBe(403)
  })

  it('returns 403 when role not allowed', async () => {
    const req = { params: { orgId: 'org-123' }, query: {} } as unknown as Request
    mockGetAuthenticatedUserId.mockReturnValue('user-1')
    mockDb.mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve({ id: 'org-123' }) }) }
      }
      if (table === 'org_members') {
        return { where: () => ({ first: () => Promise.resolve({ role: 'viewer' }) }) }
      }
      return {}
    })
    const middleware = requireOrgAccess('admin')
    await middleware(req, {} as any, mockNext)
    expect(mockNext).toHaveBeenCalledTimes(1)
    const err = mockNext.mock.calls[0]?.[0] as unknown
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).status).toBe(403)
  })
})