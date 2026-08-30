// src/tests/orgAuth.test.ts
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn(),
}));

jest.unstable_mockModule('../middleware/auth.js', () => ({
  getAuthenticatedUserId: jest.fn(),
}));

const { requireOrgAccess } = await import('../middleware/orgAuth.js');
const db = (await import('../db/index.js')).default;
const { getAuthenticatedUserId } = await import('../middleware/auth.js');

describe('requireOrgAccess middleware', () => {
  const mockNext = jest.fn() as unknown as NextFunction;
  const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockNext as jest.Mock).mockReset();
    (mockRes.status as jest.Mock).mockReset();
    (mockRes.json as jest.Mock).mockReset();
  });

  it('passes when org exists and user is a member with allowed role', async () => {
    const req = {
      params: { orgId: 'org-123' },
      query: {},
    } as unknown as Request;
    (getAuthenticatedUserId as jest.Mock).mockReturnValue('user-1');
    // @ts-ignore db mock
    (db as jest.Mock).mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve({ id: 'org-123' }) }) };
      }
      if (table === 'org_members') {
        return {
          where: () => ({ first: () => Promise.resolve({ role: 'admin' }) }),
        };
      }
      return {};
    });

    const middleware = requireOrgAccess('admin', 'member');
    await middleware(req, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  it('returns 401 when orgId or userId missing', async () => {
    const req = { params: {}, query: {} } as unknown as Request;
    (getAuthenticatedUserId as jest.Mock).mockReturnValue(null);
    const middleware = requireOrgAccess('admin');
    await middleware(req, mockRes, mockNext);
    // requireOrgAccess reports failures via next(AppError), not res.status.
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('returns 404 when organization not found', async () => {
    const req = { params: { orgId: 'missing' }, query: {} } as unknown as Request;
    (getAuthenticatedUserId as jest.Mock).mockReturnValue('user-1');
    // @ts-ignore db mock
    (db as jest.Mock).mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve(undefined) }) };
      }
      return {};
    });
    const middleware = requireOrgAccess('admin');
    await middleware(req, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('returns 403 when membership missing', async () => {
    const req = { params: { orgId: 'org-123' }, query: {} } as unknown as Request;
    (getAuthenticatedUserId as jest.Mock).mockReturnValue('user-1');
    // @ts-ignore db mock
    (db as jest.Mock).mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve({ id: 'org-123' }) }) };
      }
      if (table === 'org_members') {
        return { where: () => ({ first: () => Promise.resolve(undefined) }) };
      }
      return {};
    });
    const middleware = requireOrgAccess('admin');
    await middleware(req, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('returns 403 when role not allowed', async () => {
    const req = { params: { orgId: 'org-123' }, query: {} } as unknown as Request;
    (getAuthenticatedUserId as jest.Mock).mockReturnValue('user-1');
    // @ts-ignore db mock
    (db as jest.Mock).mockImplementation((table: string) => {
      if (table === 'organizations') {
        return { where: () => ({ first: () => Promise.resolve({ id: 'org-123' }) }) };
      }
      if (table === 'org_members') {
        return { where: () => ({ first: () => Promise.resolve({ role: 'viewer' }) }) };
      }
      return {};
    });
    const middleware = requireOrgAccess('admin');
    await middleware(req, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
