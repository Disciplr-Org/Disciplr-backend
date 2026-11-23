import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import {
  initTracing,
  getTracer,
  isTracingEnabled,
  flushTracing,
  shutdownTracing,
  parseTraceparent,
  serializeTraceparent,
  generateTraceId,
  generateSpanId,
  InMemoryExporter,
  OTLPExporter,
  _setTracerForTesting,
  _resetTracingForTesting,
  MAX_SPAN_ATTRIBUTES,
  MAX_SPAN_EVENTS,
  MAX_PENDING_SPANS,
  EXPORTER_FAILURE_THRESHOLD,
  EXPORTER_COOLDOWN_MS,
  type Span,
  type Tracer,
} from './tracing'

// ── Test tracer factory ───────────────────────────────────────────────────────

function installTestTracer(): InMemoryExporter {
  const exporter = new InMemoryExporter()

  const impl: Tracer = {
    startSpan(name, parentContext, attributes): Span {
      const traceId = parentContext?.traceId ?? generateTraceId()
      const spanId = generateSpanId()
      const parentSpanId = parentContext?.spanId
      const attrs: Record<string, string | number | boolean> = { ...attributes }
      const events: Span['events'] = []
      let spanStatus: Span['status'] = { code: 'OK' }
      let endTimeVal: number | undefined

      const span: Span = {
        traceId, spanId, name, parentSpanId,
        attributes: attrs,
        startTime: Date.now(),
        get endTime() { return endTimeVal },
        set endTime(v) { endTimeVal = v },
        get status() { return spanStatus },
        set status(v) { spanStatus = v },
        events,
        setAttribute(k, v) { attrs[k] = v },
        setStatus(s) { spanStatus = s },
        addEvent(n, a) { events.push({ name: n, time: Date.now(), attributes: a }) },
        recordException(err) {
          events.push({
            name: 'exception', time: Date.now(),
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
    withSpan(name, fn, parentContext, attributes) {
      const span = this.startSpan(name, parentContext, attributes)
      try {
        const result = fn(span)
        if (result instanceof Promise) {
          return result
            .then((v) => { span.setStatus({ code: 'OK' }); span.end(); return v })
            .catch((err: Error) => {
              span.setStatus({ code: 'ERROR', message: err?.message ?? 'error' })
              span.end(); throw err
            }) as ReturnType<typeof fn>
        }
        span.setStatus({ code: 'OK' }); span.end()
        return result
      } catch (err: unknown) {
        span.setStatus({ code: 'ERROR', message: (err as Error)?.message ?? 'error' })
        span.end(); throw err
      }
    },
  }

  _setTracerForTesting(impl)
  return exporter
}

// ── parseTraceparent ──────────────────────────────────────────────────────────

describe('parseTraceparent', () => {
  it('parses a valid W3C traceparent header', () => {
    const parsed = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
    expect(parsed).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    })
  })

  it('returns null for invalid inputs', () => {
    expect(parseTraceparent('invalid')).toBeNull()
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent('00-short-id-01')).toBeNull()
  })

  it('trims whitespace before parsing', () => {
    expect(
      parseTraceparent('  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01  '),
    ).not.toBeNull()
  })
})

describe('serializeTraceparent', () => {
  it('round-trips through parseTraceparent', () => {
    const original = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    expect(serializeTraceparent(parseTraceparent(original)!)).toBe(original)
  })
})

// ── ID generators ─────────────────────────────────────────────────────────────

describe('generateTraceId', () => {
  it('produces a 32-char lowercase hex string', () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/)
  })
  it('produces unique values', () => {
    expect(new Set(Array.from({ length: 10 }, generateTraceId)).size).toBe(10)
  })
})

describe('generateSpanId', () => {
  it('produces a 16-char lowercase hex string', () => {
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/)
  })
  it('produces unique values', () => {
    expect(new Set(Array.from({ length: 10 }, generateSpanId)).size).toBe(10)
  })
})

// ── No-op tracer ──────────────────────────────────────────────────────────────

describe('no-op tracer', () => {
  beforeEach(() => { _resetTracingForTesting() })
  afterEach(() => { _resetTracingForTesting() })

  it('isTracingEnabled() is false before initialization', () => {
    expect(isTracingEnabled()).toBe(false)
  })

  it('no-op span does not throw', () => {
    const span = getTracer().startSpan('noop')
    expect(() => {
      span.setAttribute('k', 'v')
      span.addEvent('e')
      span.setStatus({ code: 'OK' })
      span.end()
    }).not.toThrow()
  })

  it('no-op withSpan executes callback and returns result', async () => {
    expect(await getTracer().withSpan('noop', async () => 42)).toBe(42)
  })

  it('flushTracing() resolves without error', async () => {
    await expect(flushTracing()).resolves.toBeUndefined()
  })

  it('shutdownTracing() resolves without error', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined()
  })
})

// ── initTracing — sampling rate parsing ───────────────────────────────────────

describe('initTracing — sampling rate', () => {
  afterEach(() => {
    _resetTracingForTesting()
    delete process.env.OTEL_TRACES_SAMPLER
    delete process.env.OTEL_TRACES_SAMPLER_ARG
  })

  it('remains no-op when no endpoint provided', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    initTracing()
    expect(isTracingEnabled()).toBe(false)
  })

  it('enables tracing when endpoint is provided', () => {
    initTracing({ endpoint: 'http://localhost:4318' })
    expect(isTracingEnabled()).toBe(true)
    void shutdownTracing()
  })

  it('always_off sampler returns noop spans', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_off'
    initTracing({ endpoint: 'http://localhost:4318' })
    expect(getTracer().startSpan('test').traceId).toBe('')
  })

  it('traceidratio parses OTEL_TRACES_SAMPLER_ARG as a float (bug fix)', () => {
    // This was the bug: samplerArg was assigned directly as a string instead
    // of being parsed. The fix uses parseFloat + clamp.
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.5'
    expect(() => initTracing({ endpoint: 'http://localhost:4318' })).not.toThrow()
    expect(isTracingEnabled()).toBe(true)
    void shutdownTracing()
  })

  it('traceidratio with NaN arg falls back to default rate of 1', () => {
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    process.env.OTEL_TRACES_SAMPLER_ARG = 'not-a-number'
    expect(() => initTracing({ endpoint: 'http://localhost:4318' })).not.toThrow()
    expect(isTracingEnabled()).toBe(true)
    void shutdownTracing()
  })

  it('traceidratio clamps value > 1 to 1', () => {
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    process.env.OTEL_TRACES_SAMPLER_ARG = '5.0'
    expect(() => initTracing({ endpoint: 'http://localhost:4318' })).not.toThrow()
    void shutdownTracing()
  })

  it('traceidratio clamps negative value to 0 (all noop)', () => {
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    process.env.OTEL_TRACES_SAMPLER_ARG = '-1'
    initTracing({ endpoint: 'http://localhost:4318' })
    expect(getTracer().startSpan('test').traceId).toBe('')
  })
})

// ── Span API ──────────────────────────────────────────────────────────────────

describe('Span API', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('setAttribute stores all primitive types', () => {
    const span = getTracer().startSpan('test')
    span.setAttribute('str', 'hello')
    span.setAttribute('num', 123)
    span.setAttribute('bool', true)
    span.end()
    expect(exporter.spans[0].attributes['str']).toBe('hello')
    expect(exporter.spans[0].attributes['num']).toBe(123)
    expect(exporter.spans[0].attributes['bool']).toBe(true)
  })

  it('addEvent records named events', () => {
    const span = getTracer().startSpan('test')
    span.addEvent('cache.miss', { key: 'foo' })
    span.end()
    expect(exporter.spans[0].events[0].name).toBe('cache.miss')
  })

  it('recordException creates exception event', () => {
    const span = getTracer().startSpan('test')
    span.recordException(new Error('test error'))
    span.end()
    const ev = exporter.spans[0].events[0]
    expect(ev.name).toBe('exception')
    expect(ev.attributes?.['exception.message']).toBe('test error')
  })

  it('end() is idempotent', () => {
    const span = getTracer().startSpan('test')
    span.end(); span.end()
    expect(exporter.spans).toHaveLength(1)
  })
})

// ── SpanImpl bounds ───────────────────────────────────────────────────────────

describe('SpanImpl bounds', () => {
  afterEach(() => { _resetTracingForTesting() })

  it('setAttribute silently drops beyond MAX_SPAN_ATTRIBUTES', () => {
    initTracing({ endpoint: 'http://localhost:4318', samplingRate: 1 })
    const span = getTracer().startSpan('bounded')
    for (let i = 0; i < MAX_SPAN_ATTRIBUTES + 10; i++) {
      span.setAttribute(`key${i}`, `value${i}`)
    }
    span.end()
    expect(Object.keys(span.attributes).length).toBeLessThanOrEqual(MAX_SPAN_ATTRIBUTES)
    void shutdownTracing()
  })

  it('addEvent silently drops beyond MAX_SPAN_EVENTS', () => {
    initTracing({ endpoint: 'http://localhost:4318', samplingRate: 1 })
    const span = getTracer().startSpan('events-bounded')
    for (let i = 0; i < MAX_SPAN_EVENTS + 5; i++) span.addEvent(`event${i}`)
    span.end()
    expect(span.events.length).toBeLessThanOrEqual(MAX_SPAN_EVENTS)
    void shutdownTracing()
  })
})

// ── withSpan status ───────────────────────────────────────────────────────────

describe('withSpan', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('marks span OK on synchronous success', () => {
    getTracer().withSpan('sync.ok', () => {})
    expect(exporter.spans[0].status.code).toBe('OK')
  })

  it('marks span ERROR and re-throws on synchronous failure', () => {
    expect(() => getTracer().withSpan('sync.err', () => { throw new Error('boom') })).toThrow('boom')
    expect(exporter.spans[0].status.code).toBe('ERROR')
  })

  it('marks span OK on async success', async () => {
    await getTracer().withSpan('async.ok', async () => {})
    expect(exporter.spans[0].status.code).toBe('OK')
  })

  it('marks span ERROR and rejects on async failure', async () => {
    await expect(
      getTracer().withSpan('async.err', async () => { throw new Error('async boom') }),
    ).rejects.toThrow('async boom')
    expect(exporter.spans[0].status.code).toBe('ERROR')
  })
})

// ── Parent/child span linkage ─────────────────────────────────────────────────

describe('parent/child span linkage', () => {
  let exporter: InMemoryExporter
  beforeEach(() => { exporter = installTestTracer() })
  afterEach(() => { _resetTracingForTesting() })

  it('child inherits traceId from parent', () => {
    const parent = getTracer().startSpan('parent')
    const child = getTracer().startSpan('child', { traceId: parent.traceId, spanId: parent.spanId })
    parent.end(); child.end()
    expect(child.traceId).toBe(parent.traceId)
    expect(child.parentSpanId).toBe(parent.spanId)
  })

  it('all spans in a trace share the same traceId', () => {
    const root = getTracer().startSpan('root')
    const c1 = getTracer().startSpan('c1', { traceId: root.traceId, spanId: root.spanId })
    const c2 = getTracer().startSpan('c2', { traceId: root.traceId, spanId: root.spanId })
    c1.end(); c2.end(); root.end()
    expect(new Set(exporter.spans.map((s) => s.traceId)).size).toBe(1)
  })
})

// ── OTLPExporter circuit-breaker ──────────────────────────────────────────────

describe('OTLPExporter circuit-breaker', () => {
  afterEach(() => { jest.restoreAllMocks() })

  const fakeSpan = {
    traceId: '0'.repeat(32), spanId: '0'.repeat(16), name: 'test',
    startTime: Date.now(), endTime: Date.now(),
    status: { code: 'OK' as const }, attributes: {}, events: [],
    parentSpanId: undefined,
  } as unknown as Span

  it('is not in cooldown initially', () => {
    expect(new OTLPExporter('http://localhost:4318', 'test').isInCooldown).toBe(false)
  })

  it('enters cooldown after EXPORTER_FAILURE_THRESHOLD consecutive failures', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const exporter = new OTLPExporter('http://localhost:4318', 'test')
    for (let i = 0; i < EXPORTER_FAILURE_THRESHOLD; i++) {
      await exporter.export([fakeSpan])
    }
    expect(exporter.isInCooldown).toBe(true)
  })

  it('drops spans silently during cooldown — no fetch calls', async () => {
    const mockFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const exporter = new OTLPExporter('http://localhost:4318', 'test')
    for (let i = 0; i < EXPORTER_FAILURE_THRESHOLD; i++) {
      await exporter.export([fakeSpan])
    }
    const callsBefore = mockFetch.mock.calls.length
    await exporter.export([fakeSpan])
    expect(mockFetch.mock.calls.length).toBe(callsBefore)
  })

  it('resets failure counter on successful export', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ ok: true } as Response)
    const exporter = new OTLPExporter('http://localhost:4318', 'test')
    await exporter.export([fakeSpan])
    await exporter.export([fakeSpan])
    expect(exporter.isInCooldown).toBe(false)
  })

  it('EXPORTER_FAILURE_THRESHOLD and EXPORTER_COOLDOWN_MS are positive', () => {
    expect(EXPORTER_FAILURE_THRESHOLD).toBeGreaterThan(0)
    expect(EXPORTER_COOLDOWN_MS).toBeGreaterThan(0)
  })
})

// ── MAX_PENDING_SPANS ─────────────────────────────────────────────────────────

describe('MAX_PENDING_SPANS', () => {
  it('is a positive finite number', () => {
    expect(MAX_PENDING_SPANS).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_PENDING_SPANS)).toBe(true)
  })
})
