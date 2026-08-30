import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import {
  OBSERVABILITY_STATES,
  getObservabilityState,
  transitionOperation,
  isTerminal,
  isFullyResolved,
  _resetObservabilityStateForTesting,
} from './observabilityState.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(): Request {
  return { method: 'GET', path: '/test', url: '/test', headers: {} } as unknown as Request
}

function makeRes(): Response & { _listeners: Record<string, Array<() => void>> } {
  const listeners: Record<string, Array<() => void>> = {}
  const headers: Record<string, string> = {}
  return {
    statusCode: 200,
    on(event: string, cb: () => void) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
      return this as Response
    },
    emit(event: string) {
      ;(listeners[event] ?? []).forEach((cb) => cb())
    },
    setHeader(name: string, value: string) { headers[name] = value },
    getHeader(name: string) { return headers[name] },
    _listeners: listeners,
  } as any
}

// ── getObservabilityState ────────────────────────────────────────────────────

describe('getObservabilityState', () => {
  it('creates initial state with all operations pending', () => {
    const req = makeReq()
    const state = getObservabilityState(req)
    expect(state.logging.state).toBe(OBSERVABILITY_STATES.PENDING)
    expect(state.tracing.state).toBe(OBSERVABILITY_STATES.PENDING)
    expect(state.metrics.state).toBe(OBSERVABILITY_STATES.PENDING)
  })

  it('returns the same object on repeated calls (idempotent)', () => {
    const req = makeReq()
    const state1 = getObservabilityState(req)
    const state2 = getObservabilityState(req)
    expect(state1).toBe(state2)
  })

  it('creates separate state for different requests', () => {
    const req1 = makeReq()
    const req2 = makeReq()
    expect(getObservabilityState(req1)).not.toBe(getObservabilityState(req2))
  })
})

// ── transitionOperation ──────────────────────────────────────────────────────

describe('transitionOperation', () => {
  let req: Request

  beforeEach(() => {
    req = makeReq()
  })

  describe('normal transitions', () => {
    it('transitions PENDING → IN_PROGRESS', () => {
      const result = transitionOperation(req, 'logging', 'in_progress')
      expect(result).toBe(true)
      expect(getObservabilityState(req).logging.state).toBe(OBSERVABILITY_STATES.IN_PROGRESS)
      expect(typeof getObservabilityState(req).logging.startedAt).toBe('number')
    })

    it('transitions IN_PROGRESS → DONE', () => {
      transitionOperation(req, 'tracing', 'in_progress')
      const result = transitionOperation(req, 'tracing', 'done')
      expect(result).toBe(true)
      expect(getObservabilityState(req).tracing.state).toBe(OBSERVABILITY_STATES.DONE)
      expect(typeof getObservabilityState(req).tracing.completedAt).toBe('number')
    })

    it('transitions IN_PROGRESS → FAILED with error message', () => {
      transitionOperation(req, 'metrics', 'in_progress')
      const result = transitionOperation(req, 'metrics', 'failed', 'test error')
      expect(result).toBe(true)
      expect(getObservabilityState(req).metrics.state).toBe(OBSERVABILITY_STATES.FAILED)
      expect(getObservabilityState(req).metrics.error).toBe('test error')
    })

    it('transitions PENDING → FAILED (skip in_progress)', () => {
      const result = transitionOperation(req, 'logging', 'failed', 'early failure')
      expect(result).toBe(true)
      expect(getObservabilityState(req).logging.state).toBe(OBSERVABILITY_STATES.FAILED)
      expect(getObservabilityState(req).logging.error).toBe('early failure')
    })
  })

  describe('idempotency guards (terminal state rejection)', () => {
    it('rejects transition from DONE state', () => {
      transitionOperation(req, 'logging', 'in_progress')
      transitionOperation(req, 'logging', 'done')
      const result = transitionOperation(req, 'logging', 'in_progress')
      expect(result).toBe(false)
      expect(getObservabilityState(req).logging.state).toBe(OBSERVABILITY_STATES.DONE)
    })

    it('rejects transition from FAILED state', () => {
      transitionOperation(req, 'metrics', 'failed', 'error')
      const result = transitionOperation(req, 'metrics', 'in_progress')
      expect(result).toBe(false)
      expect(getObservabilityState(req).metrics.state).toBe(OBSERVABILITY_STATES.FAILED)
    })

    it('rejects IN_PROGRESS → DONE when already DONE', () => {
      transitionOperation(req, 'tracing', 'in_progress')
      transitionOperation(req, 'tracing', 'done')
      const result = transitionOperation(req, 'tracing', 'done')
      expect(result).toBe(false)
    })

    it('rejects IN_PROGRESS → FAILED when already FAILED', () => {
      transitionOperation(req, 'tracing', 'in_progress')
      transitionOperation(req, 'tracing', 'failed', 'err1')
      const result = transitionOperation(req, 'tracing', 'failed', 'err2')
      expect(result).toBe(false)
      // Original error preserved
      expect(getObservabilityState(req).tracing.error).toBe('err1')
    })
  })

  describe('invalid transitions', () => {
    it('rejects PENDING → DONE (must go through IN_PROGRESS)', () => {
      const result = transitionOperation(req, 'logging', 'done')
      expect(result).toBe(false)
      expect(getObservabilityState(req).logging.state).toBe(OBSERVABILITY_STATES.PENDING)
    })
  })

  describe('independent operations', () => {
    it('transitions logging, tracing, and metrics independently', () => {
      transitionOperation(req, 'logging', 'in_progress')
      transitionOperation(req, 'logging', 'done')

      // tracing still pending
      expect(getObservabilityState(req).tracing.state).toBe(OBSERVABILITY_STATES.PENDING)
      expect(getObservabilityState(req).metrics.state).toBe(OBSERVABILITY_STATES.PENDING)

      transitionOperation(req, 'tracing', 'in_progress')
      expect(getObservabilityState(req).logging.state).toBe(OBSERVABILITY_STATES.DONE)
      expect(getObservabilityState(req).metrics.state).toBe(OBSERVABILITY_STATES.PENDING)
    })
  })
})

// ── isTerminal ───────────────────────────────────────────────────────────────

describe('isTerminal', () => {
  it('returns false for PENDING operations', () => {
    const req = makeReq()
    expect(isTerminal(req, 'logging')).toBe(false)
  })

  it('returns false for IN_PROGRESS operations', () => {
    const req = makeReq()
    transitionOperation(req, 'logging', 'in_progress')
    expect(isTerminal(req, 'logging')).toBe(false)
  })

  it('returns true for DONE operations', () => {
    const req = makeReq()
    transitionOperation(req, 'logging', 'in_progress')
    transitionOperation(req, 'logging', 'done')
    expect(isTerminal(req, 'logging')).toBe(true)
  })

  it('returns true for FAILED operations', () => {
    const req = makeReq()
    transitionOperation(req, 'metrics', 'failed', 'error')
    expect(isTerminal(req, 'metrics')).toBe(true)
  })
})

// ── isFullyResolved ──────────────────────────────────────────────────────────

describe('isFullyResolved', () => {
  it('returns false when any operation is pending', () => {
    const req = makeReq()
    transitionOperation(req, 'logging', 'in_progress')
    transitionOperation(req, 'logging', 'done')
    transitionOperation(req, 'tracing', 'in_progress')
    transitionOperation(req, 'tracing', 'done')
    // metrics still pending
    expect(isFullyResolved(req)).toBe(false)
  })

  it('returns true when all operations are DONE', () => {
    const req = makeReq()
    for (const op of ['logging', 'tracing', 'metrics'] as const) {
      transitionOperation(req, op, 'in_progress')
      transitionOperation(req, op, 'done')
    }
    expect(isFullyResolved(req)).toBe(true)
  })

  it('returns true when all operations are FAILED', () => {
    const req = makeReq()
    for (const op of ['logging', 'tracing', 'metrics'] as const) {
      transitionOperation(req, op, 'failed', 'error')
    }
    expect(isFullyResolved(req)).toBe(true)
  })

  it('returns true with mixed terminal states (DONE + FAILED)', () => {
    const req = makeReq()
    transitionOperation(req, 'logging', 'in_progress')
    transitionOperation(req, 'logging', 'done')
    transitionOperation(req, 'tracing', 'failed', 'tracing error')
    transitionOperation(req, 'metrics', 'in_progress')
    transitionOperation(req, 'metrics', 'done')
    expect(isFullyResolved(req)).toBe(true)
  })
})

// ── Middleware integration: idempotency with res.on('finish') ────────────────

describe('middleware idempotency integration', () => {
  it('finish handler fires only once for logging even with multiple emit calls', async () => {
    const { privacyLogger } = await import('../middleware/privacy-logger.js')
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const req = makeReq()
    req.body = undefined
    req.headers = {}
    req.ip = '127.0.0.1'
    const res = makeRes()
    const next = jest.fn()

    privacyLogger(req, res as unknown as Response, next as unknown as NextFunction)

    // Emit finish twice
    res.emit('finish')
    res.emit('finish')

    // Should log only once (idempotency guard)
    const logCalls = consoleSpy.mock.calls.filter(
      (call: unknown[]) => {
        try {
          const parsed = JSON.parse((call as string[])[0])
          return parsed.event === 'http.request'
        } catch {
          return false
        }
      }
    )
    expect(logCalls).toHaveLength(1)

    consoleSpy.mockRestore()
  })
})

// ── Privacy-logger state transitions ─────────────────────────────────────────

describe('privacy-logger state transitions', () => {
  it('marks logging as done after successful emission', async () => {
    const { privacyLogger } = await import('../middleware/privacy-logger.js')
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const req = makeReq()
    req.body = undefined
    req.headers = {}
    req.ip = '127.0.0.1'
    const res = makeRes()
    const next = jest.fn()

    privacyLogger(req, res as unknown as Response, next as unknown as NextFunction)
    res.emit('finish')

    const state = getObservabilityState(req)
    expect(state.logging.state).toBe(OBSERVABILITY_STATES.DONE)
    expect(typeof state.logging.completedAt).toBe('number')

    consoleSpy.mockRestore()
  })

  it('marks logging as failed when serialization throws', async () => {
    const { privacyLogger } = await import('../middleware/privacy-logger.js')
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    // Make Date.prototype.toISOString throw to cause serialization failure.
    // Mock the entire Date constructor so no Date objects can be created.
    const OrigDate = Date
    const mockDate = jest.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      throw new Error('test serialization failure')
    })

    const req = makeReq()
    req.body = undefined
    req.headers = {}
    const res = makeRes()
    const next = jest.fn()

    privacyLogger(req, res as unknown as Response, next as unknown as NextFunction)
    res.emit('finish')

    const state = getObservabilityState(req)
    expect(state.logging.state).toBe(OBSERVABILITY_STATES.FAILED)
    expect(state.logging.error).toBe('test serialization failure')

    mockDate.mockRestore()
    consoleSpy.mockRestore()
  })
})

// ── Tracing state transitions ────────────────────────────────────────────────

describe('tracingMiddleware state transitions', () => {
  let exporter: InstanceType<typeof import('./tracing.js').InMemoryExporter>

  beforeEach(async () => {
    const tracing = await import('./tracing.js')
    const { _setTracerForTesting, InMemoryExporter } = tracing
    exporter = new InMemoryExporter()
    const TracerImpl: import('./tracing.js').Tracer = {
      startSpan(name, parentContext, attributes) {
        const traceId = parentContext?.traceId ?? tracing.generateTraceId()
        const spanId = tracing.generateSpanId()
        const attrs: Record<string, string | number | boolean> = { ...attributes }
        const events: import('./tracing.js').Span['events'] = []
        let spanStatus: import('./tracing.js').SpanStatus = { code: 'OK' }
        let endTimeVal: number | undefined
        const span: import('./tracing.js').Span = {
          traceId, spanId, name, parentSpanId: parentContext?.spanId,
          attributes: attrs, startTime: Date.now(),
          get endTime() { return endTimeVal }, set endTime(v) { endTimeVal = v },
          get status() { return spanStatus }, set status(v) { spanStatus = v },
          events,
          setAttribute(k, v) { attrs[k] = v },
          setStatus(s) { spanStatus = s },
          addEvent(eName, eAttrs) { events.push({ name: eName, time: Date.now(), attributes: eAttrs }) },
          recordException(err) { events.push({ name: 'exception', time: Date.now(), attributes: { 'exception.type': err.name, 'exception.message': err.message, 'exception.stacktrace': err.stack ?? '' } }) },
          end() { if (endTimeVal !== undefined) return; endTimeVal = Date.now(); exporter.export([span]) },
        }
        return span
      },
      withSpan(name, fn, parentContext, attributes) {
        const span = this.startSpan(name, parentContext, attributes)
        try {
          const result = fn(span)
          if (result instanceof Promise) {
            return result.then(v => { span.setStatus({ code: 'OK' }); span.end(); return v }).catch((err: Error) => { span.setStatus({ code: 'ERROR', message: err?.message ?? 'error' }); span.end(); throw err }) as any
          }
          span.setStatus({ code: 'OK' }); span.end()
          return result
        } catch (err: any) {
          span.setStatus({ code: 'ERROR', message: err?.message ?? 'error' }); span.end(); throw err
        }
      },
    }
    _setTracerForTesting(TracerImpl)
  })

  afterEach(async () => {
    const tracing = await import('./tracing.js')
    tracing._resetTracingForTesting()
  })

  it('marks tracing as done when response finishes', async () => {
    const { tracingMiddleware } = await import('./tracingMiddleware.js')
    const req = makeReq()
    const res = makeRes()
    const next = jest.fn()

    tracingMiddleware(req, res as unknown as Response, next as unknown as NextFunction)
    res.emit('finish')

    const state = getObservabilityState(req)
    expect(state.tracing.state).toBe(OBSERVABILITY_STATES.DONE)
  })

  it('does not re-record tracing on duplicate finish events', async () => {
    const { tracingMiddleware } = await import('./tracingMiddleware.js')
    const req = makeReq()
    const res = makeRes()
    const next = jest.fn()

    tracingMiddleware(req, res as unknown as Response, next as unknown as NextFunction)
    res.emit('finish')
    res.emit('finish') // duplicate

    // Should only have one span exported (idempotent)
    expect(exporter.spans).toHaveLength(1)
  })
})

// ── httpMetrics state transitions ────────────────────────────────────────────

describe('httpMetrics state transitions', () => {
  beforeEach(async () => {
    const client = await import('prom-client')
    client.default.register.clear()
  })

  it('marks metrics as done when response finishes', async () => {
    const { httpMetricsMiddleware } = await import('./httpMetrics.js')
    const req = { method: 'GET', path: '/api/users' } as unknown as Request
    const listeners: Record<string, Array<() => void>> = {}
    const res = {
      statusCode: 200,
      on(event: string, cb: () => void) {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
        return res as Response
      },
    } as any
    const next = jest.fn()

    httpMetricsMiddleware(req, res, next as unknown as NextFunction)
    ;(listeners['finish'] ?? []).forEach(cb => cb())

    const state = getObservabilityState(req)
    expect(state.metrics.state).toBe(OBSERVABILITY_STATES.DONE)
  })

  it('does not re-record metrics on duplicate finish events', async () => {
    const { httpMetricsMiddleware, httpRequestsTotal } = await import('./httpMetrics.js')
    const incSpy = jest.spyOn(httpRequestsTotal, 'inc')

    const req = { method: 'GET', path: '/api/users' } as unknown as Request
    const listeners: Record<string, Array<() => void>> = {}
    const res = {
      statusCode: 200,
      on(event: string, cb: () => void) {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
        return res as Response
      },
    } as any
    const next = jest.fn()

    httpMetricsMiddleware(req, res, next as unknown as NextFunction)
    ;(listeners['finish'] ?? []).forEach(cb => cb())
    ;(listeners['finish'] ?? []).forEach(cb => cb()) // duplicate

    // inc should be called only once (idempotent)
    expect(incSpy).toHaveBeenCalledTimes(1)
    incSpy.mockRestore()
  })

  it('skips metrics for excluded paths without setting state', async () => {
    const { httpMetricsMiddleware } = await import('./httpMetrics.js')
    const req = { method: 'GET', path: '/api/health' } as unknown as Request
    const res = {} as Response
    const next = jest.fn()

    httpMetricsMiddleware(req, res, next as unknown as NextFunction)

    // State should remain pending for excluded paths (never started)
    const state = getObservabilityState(req)
    expect(state.metrics.state).toBe(OBSERVABILITY_STATES.PENDING)
  })
})

// ── Cleanup test ─────────────────────────────────────────────────────────────

describe('cleanup', () => {
  it('_resetObservabilityStateForTesting creates fresh state', () => {
    const req = makeReq()
    transitionOperation(req, 'logging', 'in_progress')
    transitionOperation(req, 'logging', 'done')

    _resetObservabilityStateForTesting(req)

    const state = getObservabilityState(req)
    expect(state.logging.state).toBe(OBSERVABILITY_STATES.PENDING)
  })
})
