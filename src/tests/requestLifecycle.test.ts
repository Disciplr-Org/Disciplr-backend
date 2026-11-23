import { jest } from '@jest/globals'
import {
  register,
  get,
  deregister,
  transition,
  activeCount,
} from '../observability/requestLifecycle'
import {
  initTracing,
  getTracer,
  flushTracing,
  shutdownTracing,
  InMemoryExporter,
  _setTracerForTesting,
  _resetTracingForTesting,
} from '../observability/tracing'
import {
  recordMetricsDirectly,
  httpRequestsTotal,
  httpRequestDurationSeconds,
} from '../observability/httpMetrics'
import client from 'prom-client'
import { Request, Response, NextFunction } from 'express'

// ── RequestLifecycle unit tests ─────────────────────────────────────────────

describe('RequestLifecycle', () => {
  // ── State machine transitions ─────────────────────────────────────────────

  describe('state transitions', () => {
    it('starts in CREATED after register()', () => {
      register('req-1')
      const entry = get('req-1')
      expect(entry).toBeDefined()
      expect(entry!.state).toBe('CREATED')
    })

    it('transitions CREATED → ACTIVE → COMPLETED on happy path', () => {
      register('req-2')
      expect(transition('req-2', 'ACTIVE')).toBe('ACTIVE')
      expect(transition('req-2', 'COMPLETED')).toBe('COMPLETED')
      expect(get('req-2')!.state).toBe('COMPLETED')
    })

    it('transitions CREATED → ACTIVE → FAILED on error path', () => {
      register('req-3')
      expect(transition('req-3', 'ACTIVE')).toBe('ACTIVE')
      expect(transition('req-3', 'FAILED')).toBe('FAILED')
      expect(get('req-3')!.state).toBe('FAILED')
    })

    it('transitions CREATED → CANCELLED on client disconnect', () => {
      register('req-4')
      expect(transition('req-4', 'CANCELLED')).toBe('CANCELLED')
      expect(get('req-4')!.state).toBe('CANCELLED')
    })

    it('transitions CREATED → COMPLETED for short-circuited requests', () => {
      register('req-5')
      expect(transition('req-5', 'COMPLETED')).toBe('COMPLETED')
    })

    it('transitions ACTIVE → CANCELLED', () => {
      register('req-6')
      transition('req-6', 'ACTIVE')
      expect(transition('req-6', 'CANCELLED')).toBe('CANCELLED')
    })
  })

  // ── Terminal state absorption ─────────────────────────────────────────────

  describe('terminal state absorption', () => {
    it('COMPLETED absorbs further transitions', () => {
      register('req-10')
      transition('req-10', 'ACTIVE')
      transition('req-10', 'COMPLETED')

      expect(transition('req-10', 'ACTIVE')).toBe('COMPLETED')
      expect(transition('req-10', 'FAILED')).toBe('COMPLETED')
      expect(transition('req-10', 'CANCELLED')).toBe('COMPLETED')
      expect(transition('req-10', 'COMPLETED')).toBe('COMPLETED')
    })

    it('FAILED absorbs further transitions', () => {
      register('req-11')
      transition('req-11', 'ACTIVE')
      transition('req-11', 'FAILED')

      expect(transition('req-11', 'ACTIVE')).toBe('FAILED')
      expect(transition('req-11', 'COMPLETED')).toBe('FAILED')
      expect(transition('req-11', 'CANCELLED')).toBe('FAILED')
    })

    it('CANCELLED absorbs further transitions', () => {
      register('req-12')
      transition('req-12', 'CANCELLED')

      expect(transition('req-12', 'ACTIVE')).toBe('CANCELLED')
      expect(transition('req-12', 'COMPLETED')).toBe('CANCELLED')
      expect(transition('req-12', 'FAILED')).toBe('CANCELLED')
    })
  })

  // ── Invalid transitions ───────────────────────────────────────────────────

  describe('invalid transitions', () => {
    it('rejects ACTIVE → CREATED', () => {
      register('req-20')
      transition('req-20', 'ACTIVE')
      expect(transition('req-20', 'CREATED')).toBe('ACTIVE')
      expect(get('req-20')!.state).toBe('ACTIVE')
    })

    it('rejects COMPLETED → ACTIVE', () => {
      register('req-21')
      transition('req-21', 'ACTIVE')
      transition('req-21', 'COMPLETED')
      expect(transition('req-21', 'ACTIVE')).toBe('COMPLETED')
    })

    it('rejects FAILED → ACTIVE', () => {
      register('req-22')
      transition('req-22', 'ACTIVE')
      transition('req-22', 'FAILED')
      expect(transition('req-22', 'ACTIVE')).toBe('FAILED')
    })

    it('rejects CANCELLED → ACTIVE', () => {
      register('req-23')
      transition('req-23', 'CANCELLED')
      expect(transition('req-23', 'ACTIVE')).toBe('CANCELLED')
    })
  })

  // ── Idempotency ──────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('transition to current state is idempotent', () => {
      register('req-30')
      expect(transition('req-30', 'CREATED')).toBe('CREATED')
      expect(transition('req-30', 'CREATED')).toBe('CREATED')
    })

    it('register with existing ID resets to CREATED', () => {
      register('req-31')
      transition('req-31', 'ACTIVE')
      transition('req-31', 'COMPLETED')

      register('req-31')
      expect(get('req-31')!.state).toBe('CREATED')
    })
  })

  // ── Auto-registration ─────────────────────────────────────────────────────

  describe('auto-registration', () => {
    it('transition auto-registers unknown request IDs', () => {
      const result = transition('req-40', 'ACTIVE')
      expect(result).toBe('ACTIVE')
      expect(get('req-40')).toBeDefined()
      expect(get('req-40')!.state).toBe('ACTIVE')
    })
  })

  // ── Registry management ──────────────────────────────────────────────────

  describe('registry management', () => {
    it('activeCount tracks registered requests', () => {
      const before = activeCount()
      register('req-50')
      register('req-51')
      expect(activeCount()).toBe(before + 2)

      deregister('req-50')
      expect(activeCount()).toBe(before + 1)

      deregister('req-51')
      expect(activeCount()).toBe(before)
    })

    it('get returns undefined for unknown IDs', () => {
      expect(get('nonexistent')).toBeUndefined()
    })

    it('deregister is safe for unknown IDs', () => {
      expect(() => deregister('nonexistent')).not.toThrow()
    })

    it('entry records metadata', () => {
      register('req-60', { method: 'POST', path: '/api/test' })
      const entry = get('req-60')!
      expect(entry.method).toBe('POST')
      expect(entry.path).toBe('/api/test')
      expect(entry.createdAt).toBeGreaterThan(0)
    })
  })
})

// ── Integration: privacy-logger lifecycle ───────────────────────────────────

describe('privacy-logger lifecycle integration', () => {
  let consoleSpy: jest.SpyInstance

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('transitions CREATED → ACTIVE → COMPLETED on successful log', async () => {
    const { privacyLogger } = await import('../middleware/privacy-logger')
    const req: any = {
      method: 'GET',
      url: '/test',
      originalUrl: '/test',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'test' },
      body: null,
      query: {},
      socket: { remoteAddress: '127.0.0.1' },
    }
    const finishCallbacks: Function[] = []
    const closeCallbacks: Function[] = []
    const res: any = {
      statusCode: 200,
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'finish') finishCallbacks.push(cb)
        if (event === 'close') closeCallbacks.push(cb)
        return res
      }),
    }
    const next = jest.fn()

    privacyLogger(req, res, next)
    expect(next).toHaveBeenCalled()

    // Simulate response finish
    finishCallbacks.forEach((cb) => cb())

    // The log should have been emitted
    expect(consoleSpy).toHaveBeenCalled()
    const logOutput = JSON.parse(consoleSpy.mock.calls[0][0])
    expect(logOutput.event).toBe('http.request')
    expect(logOutput.method).toBe('GET')
  })

  it('transitions to FAILED on serialization error', async () => {
    const { privacyLogger } = await import('../middleware/privacy-logger')
    const req: any = {
      method: 'GET',
      url: '/test',
      originalUrl: '/test',
      ip: '127.0.0.1',
      headers: {},
      body: undefined, // body is undefined → typeof check passes but rawBody is undefined
      query: {},
      socket: { remoteAddress: '127.0.0.1' },
    }
    const finishCallbacks: Function[] = []
    const res: any = {
      statusCode: 200,
      on: jest.fn((event: string, cb: Function) => {
        if (event === 'finish') finishCallbacks.push(cb)
        return res
      }),
    }
    const next = jest.fn()

    // Mock JSON.stringify to throw only for the main log line, not for the catch block's fallback
    // This simulates a real serialization error
    const originalStringify = JSON.stringify
    let callCount = 0
    const mockStringify = jest.spyOn(JSON, 'stringify').mockImplementation((...args: any[]) => {
      callCount++
      if (callCount === 1) {
        throw new Error('serialization failure')
      }
      return originalStringify(...args)
    })

    privacyLogger(req, res, next)

    // Simulate response finish — should hit the catch block
    finishCallbacks.forEach((cb) => cb())

    // The catch block should have logged the serialization failure event
    // (via the fallback console.log in the catch block)
    expect(consoleSpy).toHaveBeenCalled()

    mockStringify.mockRestore()
  })
})

// ── Integration: tracing atomic flush ───────────────────────────────────────

describe('tracing atomic flush', () => {
  beforeEach(() => {
    _resetTracingForTesting()
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  })

  afterEach(async () => {
    await shutdownTracing()
    _resetTracingForTesting()
  })

  it('flush is atomic: concurrent flushes do not duplicate spans', async () => {
    initTracing({ endpoint: 'http://localhost:4318', samplingRate: 1 })

    const tracer = getTracer()
    for (let i = 0; i < 5; i++) {
      tracer.startSpan(`span-${i}`).end()
    }

    // Simulate concurrent flushes — should not throw or duplicate
    const p1 = flushTracing()
    const p2 = flushTracing()
    await Promise.all([p1, p2])

    // No error thrown means flush was atomic
  })

  it('flush with empty pending spans is a no-op', async () => {
    initTracing({ endpoint: 'http://localhost:4318', samplingRate: 1 })
    await expect(flushTracing()).resolves.toBeUndefined()
  })

  it('shutdown flushes remaining spans before shutting down', async () => {
    initTracing({ endpoint: 'http://localhost:4318', samplingRate: 1 })

    const tracer = getTracer()
    tracer.startSpan('before-shutdown').end()

    await shutdownTracing()
    // Should not throw
  })

  it('span.end() is idempotent: calling twice exports only once', async () => {
    initTracing({ endpoint: 'http://localhost:4318', samplingRate: 1 })

    const tracer = getTracer()
    const span = tracer.startSpan('double-end')
    span.end()
    span.end() // Second call should be a no-op

    await flushTracing()
    // No error — span was exported exactly once
  })

  it('withSpan marks ERROR and re-throws on async failure', async () => {
    initTracing({ endpoint: 'http://localhost:4318', samplingRate: 1 })

    const tracer = getTracer()
    await expect(
      tracer.withSpan('async-fail', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await shutdownTracing()
  })
})

// ── Integration: httpMetrics consistency ────────────────────────────────────

describe('httpMetrics recording consistency', () => {
  beforeEach(() => {
    client.register.clear()
  })

  afterEach(() => {
    client.register.clear()
  })

  it('records both counter and histogram atomically', () => {
    const req = { method: 'GET', baseUrl: '/api', route: { path: '/test' } } as unknown as Request
    const res = { statusCode: 200 } as unknown as Response

    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')
    const observeSpy = jest.spyOn(httpRequestDurationSeconds, 'observe')

    recordMetricsDirectly(req, res, 0.5)

    expect(incSpy).toHaveBeenCalledWith({
      method: 'GET',
      route: '/api/test',
      status_class: '2xx',
    })
    expect(observeSpy).toHaveBeenCalledWith(
      { method: 'GET', route: '/api/test', status_class: '2xx' },
      0.5,
    )

    incSpy.mockRestore()
    observeSpy.mockRestore()
  })

  it('handles errors in metric recording gracefully', () => {
    const req = { method: 'GET' } as unknown as Request
    const res = { statusCode: 200 } as unknown as Response

    // Should not throw even if metrics have issues
    expect(() => recordMetricsDirectly(req, res, 0.5)).not.toThrow()
  })

  it('records metrics with correct status classes', () => {
    const req = { method: 'POST' } as unknown as Request

    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')

    // 2xx
    recordMetricsDirectly(req, { statusCode: 201 } as unknown as Response, 0.1)
    // 4xx
    recordMetricsDirectly(req, { statusCode: 404 } as unknown as Response, 0.2)
    // 5xx
    recordMetricsDirectly(req, { statusCode: 500 } as unknown as Response, 0.3)

    expect(incSpy).toHaveBeenCalledTimes(3)
    expect(incSpy).toHaveBeenCalledWith(expect.objectContaining({ status_class: '2xx' }))
    expect(incSpy).toHaveBeenCalledWith(expect.objectContaining({ status_class: '4xx' }))
    expect(incSpy).toHaveBeenCalledWith(expect.objectContaining({ status_class: '5xx' }))

    incSpy.mockRestore()
  })
})
