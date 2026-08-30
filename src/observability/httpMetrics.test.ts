import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import client from 'prom-client'
import {
  recordMetricsDirectly,
  httpMetricsMiddleware,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestsInFlight,
  httpErrorsTotal,
  httpSlowRequestsTotal,
} from './httpMetrics'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<{
  method: string
  path: string
  baseUrl: string | undefined
  route: { path: string } | undefined
}> = {}): Partial<Request> {
  return {
    method: 'GET',
    path: '/api/vaults',
    baseUrl: '/api',
    route: { path: '/vaults' } as unknown as Request['route'],
    ...overrides,
  }
}

function makeRes(statusCode = 200): {
  statusCode: number
  writableEnded: boolean
  on: jest.Mock
  emit: (event: string) => void
} {
  const handlers: Record<string, Array<() => void>> = {}
  return {
    statusCode,
    writableEnded: false,
    on: jest.fn((event: string, handler: () => void) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(handler)
    }) as jest.Mock,
    emit(event: string) {
      ;(handlers[event] ?? []).forEach((h) => h())
    },
  }
}

beforeEach(() => { client.register.clear() })
afterEach(() => { jest.restoreAllMocks() })

// ── recordMetricsDirectly ─────────────────────────────────────────────────────

describe('recordMetricsDirectly', () => {
  it('increments httpRequestsTotal with correct labels', () => {
    const req = makeReq({ method: 'GET', baseUrl: '/api', route: { path: '/users/:id' } as unknown as Request['route'] })
    const res = makeRes(200)
    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')
    const observeSpy = jest.spyOn(httpRequestDurationSeconds, 'observe')

    recordMetricsDirectly(req as Request, res as unknown as Response, 0.05)

    expect(incSpy).toHaveBeenCalledWith({ method: 'GET', route: '/api/users/:id', status_class: '2xx' })
    expect(observeSpy).toHaveBeenCalledWith({ method: 'GET', route: '/api/users/:id', status_class: '2xx' }, 0.05)
  })

  it('uses NOT_FOUND when req.route is absent', () => {
    const req = makeReq({ method: 'POST', route: undefined })
    const res = makeRes(404)
    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 0.01)
    expect(incSpy).toHaveBeenCalledWith({ method: 'POST', route: 'NOT_FOUND', status_class: '4xx' })
  })

  it('prepends baseUrl to route path', () => {
    const req = makeReq({ method: 'DELETE', baseUrl: '/api/webhooks', route: { path: '/:id' } as unknown as Request['route'] })
    const res = makeRes(204)
    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 0.02)
    expect(incSpy).toHaveBeenCalledWith(expect.objectContaining({ route: '/api/webhooks/:id' }))
  })

  it('falls back to empty string when baseUrl is undefined', () => {
    const req = makeReq({ baseUrl: undefined, route: { path: '/health' } as unknown as Request['route'] })
    const res = makeRes(200)
    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')
    expect(() => recordMetricsDirectly(req as Request, res as unknown as Response, 0.01)).not.toThrow()
    expect(incSpy).toHaveBeenCalledWith(expect.objectContaining({ route: '/health' }))
  })

  it('distinguishes same sub-path on different routers (no cardinality collision)', () => {
    const webhookReq = makeReq({ method: 'DELETE', baseUrl: '/api/webhooks', route: { path: '/:id' } as unknown as Request['route'] })
    const orgReq = makeReq({ method: 'DELETE', baseUrl: '/api/orgs/members', route: { path: '/:userId' } as unknown as Request['route'] })
    const res = makeRes(200)
    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')
    recordMetricsDirectly(webhookReq as Request, res as unknown as Response, 0.01)
    recordMetricsDirectly(orgReq as Request, res as unknown as Response, 0.01)
    const routes = incSpy.mock.calls.map((c) => (c[0] as { route: string }).route)
    expect(routes).toContain('/api/webhooks/:id')
    expect(routes).toContain('/api/orgs/members/:userId')
  })

  // ── error counting ──

  it('increments httpErrorsTotal for 4xx', () => {
    const req = makeReq()
    const res = makeRes(404)
    const spy = jest.spyOn(httpErrorsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 0.01)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ status_class: '4xx' }))
  })

  it('increments httpErrorsTotal for 5xx', () => {
    const req = makeReq()
    const res = makeRes(500)
    const spy = jest.spyOn(httpErrorsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 0.01)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ status_class: '5xx' }))
  })

  it('does NOT increment httpErrorsTotal for 2xx', () => {
    const req = makeReq()
    const res = makeRes(200)
    const spy = jest.spyOn(httpErrorsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 0.01)
    expect(spy).not.toHaveBeenCalled()
  })

  it('does NOT increment httpErrorsTotal for 3xx', () => {
    const req = makeReq()
    const res = makeRes(301)
    const spy = jest.spyOn(httpErrorsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 0.01)
    expect(spy).not.toHaveBeenCalled()
  })

  // ── slow counting ──

  it('increments httpSlowRequestsTotal when duration >= 1s', () => {
    const req = makeReq()
    const res = makeRes(200)
    const spy = jest.spyOn(httpSlowRequestsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 1.5)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }))
  })

  it('does NOT increment httpSlowRequestsTotal for fast requests', () => {
    const req = makeReq()
    const res = makeRes(200)
    const spy = jest.spyOn(httpSlowRequestsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 0.1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('counts a slow 5xx in both error and slow counters', () => {
    const req = makeReq()
    const res = makeRes(502)
    const errSpy = jest.spyOn(httpErrorsTotal, 'inc')
    const slowSpy = jest.spyOn(httpSlowRequestsTotal, 'inc')
    recordMetricsDirectly(req as Request, res as unknown as Response, 2.0)
    expect(errSpy).toHaveBeenCalled()
    expect(slowSpy).toHaveBeenCalled()
  })
})

// ── httpMetricsMiddleware ─────────────────────────────────────────────────────

describe('httpMetricsMiddleware', () => {
  it('calls next() for normal paths and attaches finish listener', () => {
    const req = { path: '/api/vaults', method: 'GET' } as Partial<Request>
    const res = makeRes()
    const next = jest.fn() as jest.MockedFunction<NextFunction>
    httpMetricsMiddleware(req as Request, res as unknown as Response, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function))
  })

  it.each(['/api/health', '/api/v1/health', '/api/metrics', '/health', '/ready'])(
    'skips metrics for excluded path %s',
    (path) => {
      const req = { path, method: 'GET' } as Partial<Request>
      const res = { on: jest.fn() } as Partial<Response>
      const next = jest.fn() as jest.MockedFunction<NextFunction>
      httpMetricsMiddleware(req as Request, res as unknown as Response, next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(res.on).not.toHaveBeenCalled()
    },
  )

  // ── in-flight gauge ──

  it('increments in-flight on entry and decrements on finish', () => {
    const req = { path: '/api/vaults', method: 'GET' } as Partial<Request>
    const res = makeRes()
    const next = jest.fn() as jest.MockedFunction<NextFunction>
    const incSpy = jest.spyOn(httpRequestsInFlight, 'inc')
    const decSpy = jest.spyOn(httpRequestsInFlight, 'dec')

    httpMetricsMiddleware(req as Request, res as unknown as Response, next)
    expect(incSpy).toHaveBeenCalledWith({ method: 'GET' })

    res.emit('finish')
    expect(decSpy).toHaveBeenCalledWith({ method: 'GET' })
  })

  it('decrements in-flight on abnormal close (writableEnded=false)', () => {
    const req = { path: '/api/vaults', method: 'POST' } as Partial<Request>
    const res = makeRes()
    res.writableEnded = false
    const next = jest.fn() as jest.MockedFunction<NextFunction>
    const decSpy = jest.spyOn(httpRequestsInFlight, 'dec')

    httpMetricsMiddleware(req as Request, res as unknown as Response, next)
    res.emit('close')
    expect(decSpy).toHaveBeenCalledWith({ method: 'POST' })
  })

  it('does NOT double-decrement when response already finished', () => {
    const req = { path: '/api/vaults', method: 'GET' } as Partial<Request>
    const res = makeRes()
    const next = jest.fn() as jest.MockedFunction<NextFunction>
    const decSpy = jest.spyOn(httpRequestsInFlight, 'dec')

    httpMetricsMiddleware(req as Request, res as unknown as Response, next)
    res.emit('finish')
    res.writableEnded = true
    res.emit('close')
    expect(decSpy).toHaveBeenCalledTimes(1)
  })

  it('records metrics after finish', () => {
    const req = {
      path: '/api/vaults', method: 'GET', baseUrl: '/api',
      route: { path: '/vaults' },
    } as unknown as Request
    const res = makeRes(200)
    const next = jest.fn() as jest.MockedFunction<NextFunction>
    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')

    httpMetricsMiddleware(req as Request, res as unknown as Response, next)
    res.emit('finish')
    expect(incSpy).toHaveBeenCalledWith(expect.objectContaining({ status_class: '2xx', method: 'GET' }))
  })
})
