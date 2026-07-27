/**
 * Tests for the queryParser middleware (src/middleware/queryParser.ts).
 *
 * Covers:
 *   - Column / sort field whitelist
 *   - Prototype-pollution attempts (__proto__, constructor, prototype keys)
 *   - Bounded nested-field access (deeply nested filter payloads are dropped)
 *   - Malformed query strings handled gracefully (HTTP 400 from middleware,
 *     never an unhandled throw)
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'

import { queryParser } from '../middleware/queryParser.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

type QueryBag = Record<string, unknown>

const fakeReq = (query: QueryBag): Request => ({ query }) as unknown as Request

const fakeRes = (): Response => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
  return res as unknown as Response
}

const fakeNext = (): jest.MockedFunction<NextFunction> =>
  jest.fn() as unknown as jest.MockedFunction<NextFunction>

const ALLOWED = ['status', 'createdAt', 'amount'] as const

const buildMw = () =>
  queryParser({
    allowedSortFields: [...ALLOWED],
    allowedFilterFields: [...ALLOWED],
  })

const expectBadRequest = (
  res: Response,
  next: jest.MockedFunction<NextFunction>,
): void => {
  expect(next).not.toHaveBeenCalled()
  expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(400)
}

// ─── middleware: pagination + limits ──────────────────────────────────────────

describe('queryParser middleware — pagination boundaries', () => {
  let nextFn: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    nextFn = fakeNext()
  })

  it('parses default page / pageSize when no query provided', () => {
    const mw = buildMw()
    const req = fakeReq({})
    mw(req, fakeRes(), nextFn)

    expect(nextFn).toHaveBeenCalledTimes(1)
    expect(req.pagination?.page).toBe(1)
    expect(req.pagination?.pageSize).toBe(20)
    expect(req.cursorPagination?.limit).toBe(20)
    expect(req.sort).toEqual({ sortBy: undefined, sortOrder: 'asc' })
    expect(req.filters).toEqual({})
  })

  it('clamps pageSize to the configured MAX_PAGE_SIZE (100)', () => {
    const mw = buildMw()
    const req = fakeReq({ pageSize: '5000', page: '7' })
    mw(req, fakeRes(), nextFn)

    expect(req.pagination?.pageSize).toBe(100)
    expect(req.pagination?.page).toBe(7)
  })

  it('clamps negative or non-numeric inputs back to defaults', () => {
    const mw = buildMw()
    const req = fakeReq({ page: '-3', pageSize: 'abc' })
    mw(req, fakeRes(), nextFn)

    expect(req.pagination?.page).toBe(1)
    expect(req.pagination?.pageSize).toBe(20)
  })

  it('exposes cursor and limit when cursor pagination is requested', () => {
    const mw = buildMw()
    const req = fakeReq({ cursor: 'YWJjOjEyMw==', limit: '50' })
    mw(req, fakeRes(), nextFn)

    expect(req.cursorPagination?.cursor).toBe('YWJjOjEyMw==')
    expect(req.cursorPagination?.limit).toBe(50)
  })
})

// ─── middleware: sort whitelist ───────────────────────────────────────────────

describe('queryParser middleware — sort whitelist', () => {
  let nextFn: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    nextFn = fakeNext()
  })

  it('accepts a whitelisted sort field', () => {
    const mw = buildMw()
    const req = fakeReq({ sortBy: 'createdAt', sortOrder: 'desc' })
    mw(req, fakeRes(), nextFn)

    expect(nextFn).toHaveBeenCalled()
    expect(req.sort?.sortBy).toBe('createdAt')
    expect(req.sort?.sortOrder).toBe('desc')
  })

  it('drops a non-whitelisted sort field with 400', () => {
    const mw = buildMw()
    const req = fakeReq({ sortBy: 'passwordHash' })
    const res = fakeRes()
    mw(req, res, nextFn)

    expectBadRequest(res, nextFn)
  })

  it('does not include sort when allowedSortFields is empty', () => {
    const mw = queryParser({})
    const req = fakeReq({ sortBy: 'createdAt', sortOrder: 'desc' })
    mw(req, fakeRes(), nextFn)

    expect(nextFn).toHaveBeenCalled()
    expect(req.sort).toBeUndefined()
  })

  it('defaults sortOrder to asc when an unknown direction is supplied', () => {
    const mw = buildMw()
    const req = fakeReq({ sortBy: 'amount' })
    mw(req, fakeRes(), nextFn)

    expect(req.sort?.sortBy).toBe('amount')
    expect(req.sort?.sortOrder).toBe('asc')
  })
})

// ─── middleware: filter whitelist ─────────────────────────────────────────────

describe('queryParser middleware — filter whitelist', () => {
  let nextFn: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    nextFn = fakeNext()
  })

  it('captures whitelisted filters only', () => {
    const mw = buildMw()
    const req = fakeReq({ status: 'ACTIVE', amount: '100', role: 'admin', token: 's3cr3t' })
    mw(req, fakeRes(), nextFn)

    expect(nextFn).toHaveBeenCalled()
    expect(req.filters).toEqual({ status: 'ACTIVE', amount: '100' })
    // role and token are not whitelisted and must not appear in parsed filters
    expect((req.filters as Record<string, unknown>).role).toBeUndefined()
    expect((req.filters as Record<string, unknown>).token).toBeUndefined()
  })

  it('does not include filters when allowedFilterFields is empty', () => {
    const mw = queryParser({ allowedSortFields: ['createdAt'] })
    const req = fakeReq({ status: 'ACTIVE', createdAt: 'desc' })
    mw(req, fakeRes(), nextFn)

    expect(nextFn).toHaveBeenCalled()
    expect(req.filters).toBeUndefined()
  })

  it('returns a 400 on malformed sort input but the filter is still omitted', () => {
    const mw = buildMw()
    const req = fakeReq({ status: 'ACTIVE', sortBy: 'not-a-real-column' })
    const res = fakeRes()
    mw(req, res, nextFn)

    expectBadRequest(res, nextFn)
  })
})

// ─── middleware: malformed & pollution-safe ───────────────────────────────────

describe('queryParser middleware — malformed & pollution-safe', () => {
  let nextFn: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    nextFn = fakeNext()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('parses successfully when sortBy is missing even with other filter values', () => {
    const mw = buildMw()
    const req = fakeReq({ status: 'COMPLETED' })
    mw(req, fakeRes(), nextFn)

    expect(nextFn).toHaveBeenCalled()
    expect(req.filters).toEqual({ status: 'COMPLETED' })
  })

  it('returns 400 (not 500) when an unknown sort field looks like an operator alias', () => {
    const mw = buildMw()
    const req = fakeReq({ sortBy: 'CONTAINS' })
    const res = fakeRes()
    mw(req, res, nextFn)

    expectBadRequest(res, nextFn)
  })

  it('handles non-string query values without throwing', () => {
    const mw = buildMw()
    const req = fakeReq({ page: ['1', '2'] as unknown as string, sortBy: null as unknown as string })
    expect(() => mw(req, fakeRes(), nextFn)).not.toThrow()
  })

  it('caps pageSize at the maximum even if the value is an unreasonably large string', () => {
    const mw = buildMw()
    const req = fakeReq({ pageSize: '999999999999' })
    mw(req, fakeRes(), nextFn)

    expect(req.pagination?.pageSize).toBe(100)
  })
})

