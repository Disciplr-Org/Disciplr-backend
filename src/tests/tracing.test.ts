import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import {
  parseTraceparent,
  serializeTraceparent,
  generateTraceId,
  generateSpanId,
  initTracing,
  getTracer,
  isTracingEnabled,
  flushTracing,
  shutdownTracing,
  InMemoryExporter,
  _setTracerForTesting,
  _resetTracingForTesting,
  type Span,
  type Tracer,
} from '../observability/tracing.js'
import { tracingMiddleware } from '../observability/tracingMiddleware.js'

// ── Test tracer factory ──────────────────────────────────────────────────────

/**
 * Build an isolated Tracer backed by InMemoryExporter and inject it as the
 * global tracer. Returns the exporter so tests can assert on recorded spans.
 */
function installTestTracer(): InMemoryExporter {
  const exporter = new InMemoryExporter()

  const TracerImpl: Tracer = {
    startSpan(
      name: string,
      parentContext?: { traceId: string; spanId: string } | null,
      attributes?: Record<string, string | number | boolean>,
    ): Span {
      const traceId = parentContext?.traceId ?? generateTraceId()
      const spanId = generateSpanId()
      const parentSpanId = parentContext?.spanId

      const attrs: Record<string, string | number | boolean> = { ...attributes }
      const events: Span['events'] = []
      let spanStatus: Span['status'] = { code: 'OK' }
      let endTimeVal: number | undefined

      const span: Span = {
        traceId,
        spanId,
        name,
        parentSpanId,
        attributes: attrs,
        startTime: Date.now(),
        get endTime() { return endTimeVal },
        set endTime(v) { endTimeVal = v },
        get status() { return spanStatus },
        set status(v) { spanStatus = v },
        events,
        setAttribute(k, v) { attrs[k] = v },
        setStatus(s) { spanStatus = s },
        addEvent(eName, eAttrs) { events.push({ name: eName, time: Date.now(), attributes: eAttrs }) },
        recordException(err) {
          events.push({
            name: 'exception',
            time: Date.now(),
            attributes: {
              'exception.type': err.name,
              'exception.message': err.message,
              'exception.stacktrace': err.stack ?? '',
            },
          })
        },
        end() {
          if (endTimeVal !== undefined) return
          endTimeVal = Date.now()
          exporter.export([span])
        },
      }
      return span
    },

    withSpan<T>(
      name: string,
      fn: (span: Span) => T | Promise<T>,
      parentContext?: { traceId: string; spanId: string } | null,
      attributes?: Record<string, string | number | boolean>,
    ): T | Promise<T> {
      const span = this.startSpan(name, parentContext, attributes)
      try {
        const result = fn(span)
        if (result instanceof Promise) {
          return result
            .then((v) => { span.setStatus({ code: 'OK' }); span.end(); return v })
            .catch((err: Error) => {
              span.setStatus({ code: 'ERROR', message: err?.message ?? 'error' })
              span.end()
              throw err
            }) as T | Promise<T>
        }
        span.setStatus({ code: 'OK' })
        span.end()
        return result
      } catch (err: any) {
        span.setStatus({ code: 'ERROR', message: err?.message ?? 'error' })
        span.end()
        throw err
      }
    },
  }

  _setTracerForTesting(TracerImpl)
  return exporter
}

// ── Mock request/response helpers ────────────────────────────────────────────

function makeReq(overrides: Partial<{
  method: string
  path: string
  originalUrl: string
  hostname: string
  protocol: string
  ip: string
  headers: Record<string, string>
  route: { path: string }
}> = {}): Request {
  return {
    method: 'GET',
    path: '/api/test',
    originalUrl: '/api/test',
    hostname: 'localhost',
    protocol: 'http',
    ip: '127.0.0.1',
    headers: {},
    route: undefined,
    ...overrides,
  } as unknown as Request
}

function makeRes(): Response & { _headers: Record<string, string>; _finished: boolean; _statusCode: number } {
  const listeners: Record<string, Array<() => void>> = {}
  const res: any = {
    _headers: {} as Record<string, string>,
    _finished: false,
    _statusCode: 200,
    get statusCode() { return this._statusCode },
    setHeader(name: string, value: string) { this._headers[name] = value },
    getHeader(name: string) { return this._headers[name] },
    on(event: string, cb: () => void) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
      return res
    },
    emit(event: string) {
      ;(listeners[event] ?? []).forEach((cb) => cb())
    },
  }
  return res
}

// ── parseTraceparent ─────────────────────────────────────────────────────────

describe('parseTraceparent', () => {
  it('parses a valid W3C traceparent header', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const ctx = parseTraceparent(header)
    expect(ctx).not.toBeNull()
    expect(ctx!.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(ctx!.spanId).toBe('00f067aa0ba902b7')
    expect(ctx!.traceFlags).toBe('01')
  })

  it('returns null for invalid inputs', () => {
    expect(parseTraceparent('invalid')).toBeNull()
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent('00-tooshort-00f067-01')).toBeNull()
  })

  it('trims surrounding whitespace before parsing', () => {
    const header = '  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  '
    expect(parseTraceparent(header)).not.toBeNull()
  })
})

// ── serializeTraceparent ─────────────────────────────────────────────────────

describe('serializeTraceparent', () => {
  it('produces the correct W3C traceparent string', () => {
    const result = serializeTraceparent({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: '01',
    })
    expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
  })

  it('round-trips through parseTraceparent', () => {
    const original = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const ctx = parseTraceparent(original)!
    expect(serializeTraceparent(ctx)).toBe(original)
  })
})

// ── generateTraceId / generateSpanId ────────────────────────────────────────

describe('generateTraceId', () => {
  it('produces a 32-character lowercase hex string', () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('produces unique values on each call', () => {
    const ids = new Set(Array.from({ length: 10 }, generateTraceId))
    expect(ids.size).toBe(10)
  })
})

describe('generateSpanId', () => {
  it('produces a 16-character lowercase hex string', () => {
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces unique values on each call', () => {
    const ids = new Set(Array.from({ length: 10 }, generateSpanId))
    expect(ids.size).toBe(10)
  })
})

// ── InMemoryExporter ─────────────────────────────────────────────────────────

describe('InMemoryExporter', () => {
  afterEach(() => { _resetTracingForTesting() })

  it('collects exported spans', () => {
    const exporter = installTestTracer()
    getTracer().startSpan('test.op').end()
    expect(exporter.spans).toHaveLength(1)
    expect(exporter.spans[0].name).toBe('test.op')
  })

  it('reset() clears collected spans', () => {
    const exporter = installTestTracer()
    getTracer().startSpan('a').end()
    getTracer().startSpan('b').end()
    exporter.reset()
    expect(exporter.spans).toHaveLength(0)
  })
})

// ── Parent/child span linkage ────────────────────────────────────────────────

describe('parent/child span linkage', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('child span inherits traceId from parent context', () => {
    const parent = getTracer().startSpan('parent')
    const child = getTracer().startSpan('child', { traceId: parent.traceId, spanId: parent.spanId })
    parent.end()
    child.end()

    expect(child.traceId).toBe(parent.traceId)
    expect(child.parentSpanId).toBe(parent.spanId)
    expect(child.spanId).not.toBe(parent.spanId)
  })

  it('root span has no parentSpanId', () => {
    const span = getTracer().startSpan('root')
    span.end()
    expect(span.parentSpanId).toBeUndefined()
  })

  it('withSpan propagates parent context to nested spans', async () => {
    const tracer = getTracer()
    await tracer.withSpan('outer', async (outer) => {
      await tracer.withSpan(
        'inner',
        async () => {},
        { traceId: outer.traceId, spanId: outer.spanId },
      )
    })

    expect(exporter.spans).toHaveLength(2)
    const inner = exporter.spans.find((s) => s.name === 'inner')!
    const outer = exporter.spans.find((s) => s.name === 'outer')!
    expect(inner.traceId).toBe(outer.traceId)
    expect(inner.parentSpanId).toBe(outer.spanId)
  })
})

// ── withSpan status handling ─────────────────────────────────────────────────

describe('withSpan', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('marks span OK on synchronous success', () => {
    getTracer().withSpan('sync.ok', (span) => { span.setAttribute('x', 1) })
    expect(exporter.spans[0].status.code).toBe('OK')
  })

  it('marks span ERROR and re-throws on synchronous failure', () => {
    expect(() => {
      getTracer().withSpan('sync.err', () => { throw new Error('boom') })
    }).toThrow('boom')
    expect(exporter.spans[0].status.code).toBe('ERROR')
    expect((exporter.spans[0].status as any).message).toBe('boom')
  })

  it('marks span OK on async success', async () => {
    await getTracer().withSpan('async.ok', async () => { await Promise.resolve() })
    expect(exporter.spans[0].status.code).toBe('OK')
  })

  it('marks span ERROR and rejects on async failure', async () => {
    await expect(
      getTracer().withSpan('async.err', async () => { throw new Error('async boom') }),
    ).rejects.toThrow('async boom')
    expect(exporter.spans[0].status.code).toBe('ERROR')
  })

  it('passes initial attributes to the started span', () => {
    getTracer().withSpan('with.attrs', () => {}, null, { key: 'value', num: 42 })
    expect(exporter.spans[0].attributes['key']).toBe('value')
    expect(exporter.spans[0].attributes['num']).toBe(42)
  })
})

// ── Span attribute and event API ─────────────────────────────────────────────

describe('Span API', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('setAttribute stores values of all primitive types', () => {
    const span = getTracer().startSpan('test')
    span.setAttribute('str', 'hello')
    span.setAttribute('num', 123)
    span.setAttribute('bool', true)
    span.end()
    expect(exporter.spans[0].attributes['str']).toBe('hello')
    expect(exporter.spans[0].attributes['num']).toBe(123)
    expect(exporter.spans[0].attributes['bool']).toBe(true)
  })

  it('addEvent records named events with attributes', () => {
    const span = getTracer().startSpan('test')
    span.addEvent('cache.miss', { key: 'foo' })
    span.end()
    expect(exporter.spans[0].events).toHaveLength(1)
    expect(exporter.spans[0].events[0].name).toBe('cache.miss')
    expect(exporter.spans[0].events[0].attributes?.key).toBe('foo')
  })

  it('recordException creates an exception event with standard attributes', () => {
    const span = getTracer().startSpan('test')
    span.recordException(new Error('test error'))
    span.end()
    const ev = exporter.spans[0].events[0]
    expect(ev.name).toBe('exception')
    expect(ev.attributes?.['exception.message']).toBe('test error')
    expect(ev.attributes?.['exception.type']).toBe('Error')
  })

  it('end() is idempotent — calling twice exports only once', () => {
    const span = getTracer().startSpan('test')
    span.end()
    span.end()
    expect(exporter.spans).toHaveLength(1)
  })
})

// ── No-op tracer when endpoint not configured ────────────────────────────────

describe('no-op tracer when endpoint not configured', () => {
  beforeEach(() => { _resetTracingForTesting() })
  afterEach(() => { _resetTracingForTesting() })

  it('isTracingEnabled() returns false before initialization', () => {
    expect(isTracingEnabled()).toBe(false)
  })

  it('no-op startSpan returns a span that does not throw', () => {
    const span = getTracer().startSpan('noop')
    expect(() => {
      span.setAttribute('k', 'v')
      span.addEvent('e')
      span.setStatus({ code: 'OK' })
      span.end()
    }).not.toThrow()
  })

  it('no-op withSpan executes the callback and returns its result', async () => {
    const result = await getTracer().withSpan('noop', async () => 42)
    expect(result).toBe(42)
  })

  it('flushTracing() resolves without error when no tracer is active', async () => {
    await expect(flushTracing()).resolves.toBeUndefined()
  })

  it('shutdownTracing() resolves without error when no tracer is active', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined()
  })
})

// ── initTracing ──────────────────────────────────────────────────────────────

describe('initTracing', () => {
  afterEach(() => { _resetTracingForTesting() })

  it('remains a no-op when no endpoint is provided', () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    initTracing()
    expect(isTracingEnabled()).toBe(false)
    if (prev !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev
  })

  it('enables tracing when an endpoint is provided via options', () => {
    initTracing({ endpoint: 'http://localhost:4318' })
    expect(isTracingEnabled()).toBe(true)
  })

  it('always_off sampler returns no-op spans (empty traceId)', () => {
    const prevSampler = process.env.OTEL_TRACES_SAMPLER
    process.env.OTEL_TRACES_SAMPLER = 'always_off'
    initTracing({ endpoint: 'http://localhost:4318' })
    const span = getTracer().startSpan('test')
    span.end()
    expect(span.traceId).toBe('')
    process.env.OTEL_TRACES_SAMPLER = prevSampler
  })
})

// ── tracingMiddleware ────────────────────────────────────────────────────────

describe('tracingMiddleware', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  function runMiddleware(req: Request, res: ReturnType<typeof makeRes>): boolean {
    let called = false
    const next: NextFunction = () => { called = true }
    tracingMiddleware(req, res as unknown as Response, next)
    return called
  }

  it('calls next() for non-excluded paths', () => {
    const req = makeReq({ path: '/api/vaults' })
    const res = makeRes()
    expect(runMiddleware(req, res)).toBe(true)
  })

  it('calls next() and skips span creation for /health', () => {
    const req = makeReq({ path: '/health' })
    const res = makeRes()
    runMiddleware(req, res)
    expect(exporter.spans).toHaveLength(0)
  })

  it('calls next() and skips span creation for /api/metrics', () => {
    const req = makeReq({ path: '/api/metrics' })
    const res = makeRes()
    runMiddleware(req, res)
    expect(exporter.spans).toHaveLength(0)
  })

  it('injects a valid traceparent header on the response', () => {
    const req = makeReq({ path: '/api/vaults' })
    const res = makeRes()
    runMiddleware(req, res)
    expect(res._headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })

  it('propagates an inbound traceparent: child span shares the same traceId', () => {
    const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const req = makeReq({ path: '/api/vaults', headers: { traceparent: inbound } })
    const res = makeRes()
    runMiddleware(req, res)

    res.emit('finish')
    const span = exporter.spans[0]
    expect(span?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
  })

  it('uses x-correlation-id as correlation.id attribute', () => {
    const req = makeReq({
      path: '/api/vaults',
      headers: { 'x-correlation-id': 'corr-123' },
    })
    const res = makeRes()
    runMiddleware(req, res)
    res.emit('finish')

    expect(exporter.spans[0].attributes['correlation.id']).toBe('corr-123')
  })

  it('falls back to x-request-id when x-correlation-id is absent', () => {
    const req = makeReq({
      path: '/api/vaults',
      headers: { 'x-request-id': 'req-456' },
    })
    const res = makeRes()
    runMiddleware(req, res)
    res.emit('finish')

    expect(exporter.spans[0].attributes['correlation.id']).toBe('req-456')
  })

  it('falls back to traceId when no correlation headers are present', () => {
    const req = makeReq({ path: '/api/vaults' })
    const res = makeRes()
    runMiddleware(req, res)
    res.emit('finish')

    const span = exporter.spans[0]
    expect(span.attributes['correlation.id']).toBe(span.traceId)
  })

  it('records http.status_code after the response finishes', () => {
    const req = makeReq({ path: '/api/vaults', method: 'POST' })
    const res = makeRes()
    res._statusCode = 201
    runMiddleware(req, res)
    res.emit('finish')

    expect(exporter.spans[0].attributes['http.status_code']).toBe(201)
  })

  it('sets span status ERROR for 4xx responses', () => {
    const req = makeReq({ path: '/api/vaults' })
    const res = makeRes()
    res._statusCode = 404
    runMiddleware(req, res)
    res.emit('finish')

    expect(exporter.spans[0].status.code).toBe('ERROR')
  })

  it('sets span status OK for 2xx responses', () => {
    const req = makeReq({ path: '/api/vaults' })
    const res = makeRes()
    res._statusCode = 200
    runMiddleware(req, res)
    res.emit('finish')

    expect(exporter.spans[0].status.code).toBe('OK')
  })

  it('records http.method attribute on the span', () => {
    const req = makeReq({ path: '/api/vaults', method: 'DELETE' })
    const res = makeRes()
    runMiddleware(req, res)
    res.emit('finish')

    expect(exporter.spans[0].attributes['http.method']).toBe('DELETE')
  })
})

// ── Correlation ID propagation through span chain ────────────────────────────

describe('correlation ID propagation through span chain', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('child spans carry the same correlation.id as the root span', () => {
    const correlationId = 'corr-abc-123'
    const tracer = getTracer()

    const parent = tracer.startSpan('http.request', null, { 'correlation.id': correlationId })
    const child = tracer.startSpan(
      'soroban.create_vault',
      { traceId: parent.traceId, spanId: parent.spanId },
      { 'correlation.id': correlationId },
    )
    child.end()
    parent.end()

    expect(exporter.spans).toHaveLength(2)
    for (const span of exporter.spans) {
      expect(span.attributes['correlation.id']).toBe(correlationId)
    }
  })

  it('all spans in a trace share the same traceId', () => {
    const tracer = getTracer()
    const root = tracer.startSpan('root')
    const c1 = tracer.startSpan('child1', { traceId: root.traceId, spanId: root.spanId })
    const c2 = tracer.startSpan('child2', { traceId: root.traceId, spanId: root.spanId })
    c1.end()
    c2.end()
    root.end()

    const traceIds = new Set(exporter.spans.map((s) => s.traceId))
    expect(traceIds.size).toBe(1)
  })
})

// ── Job queue span instrumentation ───────────────────────────────────────────

describe('job queue span instrumentation', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('wraps job handler execution in a tracer span', async () => {
    const { InMemoryJobQueue } = await import('../jobs/queue.js')
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })

    queue.registerHandler('oracle.call', async () => {})
    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XLM' })
    queue.start()

    await new Promise((r) => setTimeout(r, 150))
    await queue.stop()

    const jobSpan = exporter.spans.find((s) => s.name === 'job.oracle.call')
    expect(jobSpan).toBeDefined()
    expect(jobSpan?.attributes['job.type']).toBe('oracle.call')
    expect(jobSpan?.attributes['job.attempt']).toBe(1)
    expect(jobSpan?.attributes['job.max_attempts']).toBe(3)
  })

  it('marks the job span ERROR when the handler throws', async () => {
    const { InMemoryJobQueue } = await import('../jobs/queue.js')
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })

    queue.registerHandler('oracle.call', async () => { throw new Error('handler failure') })
    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XLM' }, { maxAttempts: 1 })
    queue.start()

    await new Promise((r) => setTimeout(r, 150))
    await queue.stop()

    const jobSpan = exporter.spans.find((s) => s.name === 'job.oracle.call')
    expect(jobSpan).toBeDefined()
    expect(jobSpan?.status.code).toBe('ERROR')
  })

  it('records job.id attribute on each span', async () => {
    const { InMemoryJobQueue } = await import('../jobs/queue.js')
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })

    queue.registerHandler('oracle.call', async () => {})
    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XLM' })
    queue.start()

    await new Promise((r) => setTimeout(r, 150))
    await queue.stop()

    const jobSpan = exporter.spans.find((s) => s.name === 'job.oracle.call')
    expect(typeof jobSpan?.attributes['job.id']).toBe('string')
    expect((jobSpan?.attributes['job.id'] as string).length).toBeGreaterThan(0)
  })
})
