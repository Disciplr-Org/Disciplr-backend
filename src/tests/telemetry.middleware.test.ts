import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { NextFunction, Request, Response } from 'express'

const mockIncrement = jest.fn<(labels: Record<string, string>) => void>()
const mockObserve = jest.fn<(value: number, labels: Record<string, string>) => void>()
let resolveMetricsReady: (() => void) | undefined
const metricsReady = new Promise<void>((resolve) => {
  resolveMetricsReady = resolve
})

const mockCounterConstructor = jest.fn(() => ({ inc: mockIncrement }))
const mockHistogramConstructor = jest.fn(() => {
  resolveMetricsReady?.()
  return { observe: mockObserve }
})

jest.unstable_mockModule('prom-client', () => ({
  Counter: mockCounterConstructor,
  Histogram: mockHistogramConstructor,
}))

jest.unstable_mockModule('../observability/metricsRegistry.js', () => ({
  register: {},
}))

const { default: defaultTelemetry, requestTelemetry } = await import(
  '../middleware/telemetry.js'
)

type RequestOptions = {
  method?: string
  baseUrl?: string
  routePath?: string | null
  headers?: Record<string, string>
  originalUrl?: string
}

function makeRequest(options: RequestOptions = {}): Request {
  const route = options.routePath === null
    ? undefined
    : { path: options.routePath ?? '/login/:userId' }

  return {
    method: options.method ?? 'POST',
    baseUrl: options.baseUrl ?? '/api/auth',
    route,
    headers: options.headers ?? {},
    originalUrl: options.originalUrl ?? '/api/auth/login/user-1',
  } as unknown as Request
}

function makeResponse(statusCode = 200): Response & { emit: (event: string) => void } {
  const listeners = new Map<string, Array<() => void>>()
  const response = {
    statusCode,
    on(event: string, listener: () => void) {
      const eventListeners = listeners.get(event) ?? []
      eventListeners.push(listener)
      listeners.set(event, eventListeners)
      return response
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }

  return response as unknown as Response & { emit: (event: string) => void }
}

const runMiddleware = (
  options: RequestOptions = {},
  statusCode = 200,
): { req: Request; res: Response & { emit: (event: string) => void }; next: jest.Mock<NextFunction> } => {
  const req = makeRequest(options)
  const res = makeResponse(statusCode)
  const next = jest.fn<NextFunction>()

  requestTelemetry(req, res, next)

  return { req, res, next }
}

beforeEach(() => {
  mockIncrement.mockReset()
  mockObserve.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('requestTelemetry', () => {
  it('records method, matched route, status class, and duration without sensitive request values', async () => {
    const bootstrap = runMiddleware()
    bootstrap.res.emit('finish')
    await metricsReady

    const { res, next } = runMiddleware({
      method: 'POST',
      baseUrl: '/api/auth',
      routePath: '/login/:userId',
      originalUrl: '/api/auth/login/alice?token=query-secret',
      headers: {
        authorization: 'Bearer header-secret',
        'x-api-key': 'api-key-secret',
        cookie: 'session=cookie-secret',
      },
    })
    expect(next).toHaveBeenCalledTimes(1)

    res.emit('finish')

    expect(mockIncrement).toHaveBeenCalledTimes(1)
    expect(mockIncrement).toHaveBeenCalledWith({
      method: 'POST',
      route: '/api/auth/login/:userId',
      status_class: '2xx',
    })
    expect(mockObserve).toHaveBeenCalledTimes(1)
    const [duration, labels] = mockObserve.mock.calls[0]
    expect(duration).toEqual(expect.any(Number))
    expect(duration).toBeGreaterThanOrEqual(0)
    expect(labels).toEqual({ method: 'POST', route: '/api/auth/login/:userId' })
    expect(JSON.stringify([mockIncrement.mock.calls, mockObserve.mock.calls])).not.toContain('secret')
  })

  it.each([
    [302, '3xx'],
    [401, '4xx'],
    [503, '5xx'],
  ])('labels status %i as %s', async (statusCode, statusClass) => {
    const { res } = runMiddleware({}, statusCode)
    await metricsReady

    res.emit('finish')

    expect(mockIncrement).toHaveBeenCalledWith(expect.objectContaining({
      status_class: statusClass,
    }))
  })

  it('uses the unmatched label when Express has no matched route', async () => {
    const { res } = runMiddleware({ routePath: null, baseUrl: '/api/auth' })
    await metricsReady

    res.emit('finish')

    expect(mockIncrement).toHaveBeenCalledWith(expect.objectContaining({
      route: 'unmatched',
    }))
    expect(mockObserve).toHaveBeenCalledWith(
      expect.any(Number),
      { method: 'POST', route: 'unmatched' },
    )
  })

  it('records only once if finish and close both fire', async () => {
    const { res } = runMiddleware()
    await metricsReady

    res.emit('finish')
    res.emit('close')

    expect(mockIncrement).toHaveBeenCalledTimes(1)
    expect(mockObserve).toHaveBeenCalledTimes(1)
  })

  it('does not interrupt the request if incrementing the counter fails', async () => {
    const { res, next } = runMiddleware()
    await metricsReady
    mockIncrement.mockImplementation(() => {
      throw new Error('counter failure')
    })

    expect(() => res.emit('finish')).not.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
    expect(mockIncrement).toHaveBeenCalledTimes(1)
    expect(mockObserve).not.toHaveBeenCalled()
  })

  it('does not interrupt the request if observing duration fails', async () => {
    const { res, next } = runMiddleware()
    await metricsReady
    mockObserve.mockImplementation(() => {
      throw new Error('histogram failure')
    })

    expect(() => res.emit('finish')).not.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
    expect(mockIncrement).toHaveBeenCalledTimes(1)
    expect(mockObserve).toHaveBeenCalledTimes(1)
  })
})

it('exports the same middleware as its named and default export', () => {
  expect(defaultTelemetry).toBe(requestTelemetry)
})
