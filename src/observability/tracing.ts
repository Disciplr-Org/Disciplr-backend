import { randomUUID } from 'node:crypto'

// ── Trace context (W3C traceparent-compatible) ──────────────────────────────

export interface TraceContext {
  traceId: string
  spanId: string
  traceFlags: string
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/**
 * Parse a W3C traceparent header value.
 * Format: `{version}-{traceId}-{spanId}-{traceFlags}`
 */
export function parseTraceparent(header: string): TraceContext | null {
  const match = header.trim().match(TRACEPARENT_PATTERN)
  if (!match) return null
  return { traceId: match[1], spanId: match[2], traceFlags: match[3] }
}

/**
 * Serialize a TraceContext to a W3C traceparent header value.
 */
export function serializeTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`
}

/**
 * Generate a random trace ID (128-bit hex).
 */
export function generateTraceId(): string {
  return randomUUID().replace(/-/g, '')
}

/**
 * Generate a random span ID (64-bit hex).
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Maximum spans buffered in memory before a forced flush.
 * Prevents unbounded memory growth under high traffic or a slow exporter.
 */
export const MAX_PENDING_SPANS = 200

/**
 * Maximum attributes per span. Extra setAttribute() calls beyond this
 * limit are silently dropped to bound per-span memory.
 */
export const MAX_SPAN_ATTRIBUTES = 64

/**
 * Maximum events per span.
 */
export const MAX_SPAN_EVENTS = 32

/**
 * Consecutive OTLP export failures before the exporter enters cooldown.
 * During cooldown, spans are dropped (not buffered) to prevent OOM when
 * the collector is unavailable.
 */
export const EXPORTER_FAILURE_THRESHOLD = 5

/**
 * Cooldown duration in milliseconds after the failure threshold is reached.
 * The exporter retries once this period elapses.
 */
export const EXPORTER_COOLDOWN_MS = 30_000

// ── Span interface ──────────────────────────────────────────────────────────

export type SpanStatus = { code: 'OK' } | { code: 'ERROR'; message?: string }

export interface Span {
  readonly traceId: string
  readonly spanId: string
  readonly name: string
  readonly parentSpanId?: string
  readonly attributes: Record<string, string | number | boolean>
  startTime: number
  endTime?: number
  status: SpanStatus
  events: Array<{
    name: string
    time: number
    attributes?: Record<string, string | number | boolean>
  }>

  setAttribute(key: string, value: string | number | boolean): void
  setStatus(status: SpanStatus): void
  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void
  recordException(error: Error): void
  end(): void
}

/**
 * Internal span implementation. Not exported directly — created via
 * tracer.startSpan().
 */
class SpanImpl implements Span {
  readonly traceId: string
  readonly spanId: string
  readonly name: string
  readonly parentSpanId?: string
  readonly attributes: Record<string, string | number | boolean> = {}
  startTime: number
  endTime?: number
  status: SpanStatus = { code: 'OK' }
  events: Array<{
    name: string
    time: number
    attributes?: Record<string, string | number | boolean>
  }> = []

  private readonly onEnd: (span: Span) => void

  constructor(
    name: string,
    traceId: string,
    spanId: string,
    parentSpanId: string | undefined,
    onEnd: (span: Span) => void,
  ) {
    this.name = name
    this.traceId = traceId
    this.spanId = spanId
    this.parentSpanId = parentSpanId
    this.startTime = Date.now()
    this.onEnd = onEnd
  }

  setAttribute(key: string, value: string | number | boolean): void {
    if (Object.keys(this.attributes).length >= MAX_SPAN_ATTRIBUTES) return
    this.attributes[key] = value
  }

  setStatus(status: SpanStatus): void {
    this.status = status
  }

  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    if (this.events.length >= MAX_SPAN_EVENTS) return
    this.events.push({ name, time: Date.now(), attributes })
  }

  recordException(error: Error): void {
    this.addEvent('exception', {
      'exception.type': error.name,
      'exception.message': error.message,
      'exception.stacktrace': error.stack ?? '',
    })
  }

  end(): void {
    if (this.endTime !== undefined) return
    this.endTime = Date.now()
    this.onEnd(this)
  }
}

// ── Tracer ──────────────────────────────────────────────────────────────────

export interface Tracer {
  /**
   * Start a new span. If a parent context is provided the new span becomes
   * a child; otherwise a new trace root is created.
   */
  startSpan(
    name: string,
    parentContext?: { traceId: string; spanId: string } | null,
    attributes?: Record<string, string | number | boolean>,
  ): Span

  /**
   * Execute a function within a new span. The span is automatically ended
   * when the function returns (or throws).
   */
  withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    parentContext?: { traceId: string; spanId: string } | null,
    attributes?: Record<string, string | number | boolean>,
  ): T | Promise<T>
}

// ── Span exporter interface ─────────────────────────────────────────────────

export interface SpanExporter {
  export(spans: Span[]): void | Promise<void>
  shutdown?(): void | Promise<void>
}

/**
 * OTLP/HTTP span exporter.
 *
 * Circuit-breaker: after EXPORTER_FAILURE_THRESHOLD consecutive failures
 * the exporter enters a cooldown of EXPORTER_COOLDOWN_MS. During cooldown
 * export() returns immediately so the caller is never back-pressured.
 * The breaker resets on the first successful export after cooldown.
 */
export class OTLPExporter implements SpanExporter {
  private readonly endpoint: string
  private readonly serviceName: string

  private consecutiveFailures = 0
  private coolingDownUntil = 0

  constructor(endpoint: string, serviceName: string) {
    this.endpoint = endpoint.replace(/\/+$/, '')
    this.serviceName = serviceName
  }

  /** Exposed for testing. */
  get isInCooldown(): boolean {
    return Date.now() < this.coolingDownUntil
  }

  async export(spans: Span[]): Promise<void> {
    if (spans.length === 0) return

    // Circuit breaker: drop silently during cooldown
    if (this.isInCooldown) return

    const resource = { 'service.name': this.serviceName }

    const otelSpans = spans.map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      name: s.name,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: BigInt(s.startTime) * 1_000_000n,
      endTimeUnixNano: BigInt(s.endTime ?? s.startTime) * 1_000_000n,
      status: {
        code: s.status.code === 'OK' ? 1 : 2,
        message:
          (s.status as { code: string; message?: string }).message ?? '',
      },
      attributes: Object.entries(s.attributes).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
      events: s.events.map((e) => ({
        name: e.name,
        timeUnixNano: BigInt(e.time) * 1_000_000n,
        attributes: e.attributes
          ? Object.entries(e.attributes).map(([key, value]) => ({
              key,
              value: { stringValue: String(value) },
            }))
          : [],
      })),
      parentSpanId: s.parentSpanId ?? '',
    }))

    const body = JSON.stringify({
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            { scope: { name: 'disciplr-backend' }, spans: otelSpans },
          ],
        },
      ],
    })

    try {
      const response = await fetch(`${this.endpoint}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        this._handleFailure(`HTTP ${response.status} ${response.statusText}`)
      } else {
        // Reset circuit breaker on success
        this.consecutiveFailures = 0
        this.coolingDownUntil = 0
      }
    } catch (err: unknown) {
      this._handleFailure((err as Error)?.message ?? 'unknown error')
    }
  }

  private _handleFailure(reason: string): void {
    this.consecutiveFailures++
    console.error(
      `[Tracing] OTLP export failed (attempt ${this.consecutiveFailures}/${EXPORTER_FAILURE_THRESHOLD}): ${reason}`,
    )
    if (this.consecutiveFailures >= EXPORTER_FAILURE_THRESHOLD) {
      this.coolingDownUntil = Date.now() + EXPORTER_COOLDOWN_MS
      console.error(
        `[Tracing] OTLP exporter entering cooldown for ${EXPORTER_COOLDOWN_MS}ms`,
      )
    }
  }
}

/**
 * In-memory span exporter for testing. Collects all exported spans.
 */
export class InMemoryExporter implements SpanExporter {
  readonly spans: Span[] = []

  export(spans: Span[]): void {
    this.spans.push(...spans)
  }

  reset(): void {
    this.spans.length = 0
  }
}

// ── Tracer implementation ───────────────────────────────────────────────────

class TracerImpl implements Tracer {
  private readonly exporter: SpanExporter
  private readonly samplingRate: number
  private readonly pendingSpans: Span[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(exporter: SpanExporter, samplingRate: number) {
    this.exporter = exporter
    this.samplingRate = samplingRate

    if (samplingRate > 0) {
      this.flushTimer = setInterval(() => void this.flush(), 5_000)
      if (
        typeof (
          this.flushTimer as NodeJS.Timeout & { unref?: () => void }
        ).unref === 'function'
      ) {
        (this.flushTimer as NodeJS.Timeout & { unref: () => void }).unref()
      }
    }
  }

  startSpan(
    name: string,
    parentContext?: { traceId: string; spanId: string } | null,
    attributes?: Record<string, string | number | boolean>,
  ): Span {
    if (this.samplingRate <= 0) return NoopSpan.instance
    if (this.samplingRate < 1 && Math.random() > this.samplingRate)
      return NoopSpan.instance

    // Back-pressure: drop when pending buffer is full
    if (this.pendingSpans.length >= MAX_PENDING_SPANS) return NoopSpan.instance

    const traceId = parentContext?.traceId ?? generateTraceId()
    const spanId = generateSpanId()
    const parentSpanId = parentContext?.spanId

    const span = new SpanImpl(name, traceId, spanId, parentSpanId, (s) => {
      if (this.pendingSpans.length < MAX_PENDING_SPANS) {
        this.pendingSpans.push(s)
      }
      if (this.pendingSpans.length >= 50) {
        void this.flush()
      }
    })

    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v)
      }
    }

    return span
  }

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
          .then((v) => {
            span.setStatus({ code: 'OK' })
            span.end()
            return v
          })
          .catch((err: unknown) => {
            span.setStatus({
              code: 'ERROR',
              message: (err as Error)?.message ?? 'Unknown error',
            })
            span.end()
            throw err
          })
      }
      span.setStatus({ code: 'OK' })
      span.end()
      return result
    } catch (err: unknown) {
      span.setStatus({
        code: 'ERROR',
        message: (err as Error)?.message ?? 'Unknown error',
      })
      span.end()
      throw err
    }
  }

  /**
   * Atomically drain all pending spans and export them.
   *
   * The splice(0) call is synchronous and removes all elements from
   * pendingSpans in one operation. If multiple flush() calls race (e.g.
   * from concurrent shutdown + timer), each sees a different batch —
   * no span is exported twice.
   */
  async flush(): Promise<void> {
    if (this.pendingSpans.length === 0) return
    const batch = this.pendingSpans.splice(0)
    try {
      await this.exporter.export(batch)
    } catch {
      // Exporter handles its own error logging.
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
    if (this.exporter.shutdown) {
      await this.exporter.shutdown()
    }
  }
}

// ── No-op span ──────────────────────────────────────────────────────────────

class NoopSpan implements Span {
  static readonly instance = new NoopSpan()
  readonly traceId = ''
  readonly spanId = ''
  readonly name = ''
  readonly attributes: Record<string, string | number | boolean> = {}
  startTime = 0
  status: SpanStatus = { code: 'OK' }
  events: Array<{
    name: string
    time: number
    attributes?: Record<string, string | number | boolean>
  }> = []

  setAttribute(): void {}
  setStatus(): void {}
  addEvent(): void {}
  recordException(): void {}
  end(): void {}
}

// ── No-op tracer ────────────────────────────────────────────────────────────

class NoopTracerImpl implements Tracer {
  startSpan(): Span {
    return NoopSpan.instance
  }
  withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
  ): T | Promise<T> {
    return fn(NoopSpan.instance)
  }
}

// ── Module singleton ────────────────────────────────────────────────────────

let _tracer: Tracer = new NoopTracerImpl()
let _exporter: SpanExporter | null = null

/**
 * Initialise the global tracer. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set,
 * spans are exported via OTLP/HTTP; otherwise a no-op tracer is used.
 *
 * Call once at startup (before any middleware or routes).
 *
 * Sampling rate resolution order:
 *  1. options.samplingRate (explicit argument)
 *  2. OTEL_TRACES_SAMPLER=always_off → 0
 *  3. OTEL_TRACES_SAMPLER=traceidratio + OTEL_TRACES_SAMPLER_ARG → parsed float, clamped to [0,1]
 *  4. Default: 1 (sample everything)
 */
export function initTracing(options?: {
  endpoint?: string
  serviceName?: string
  samplingRate?: number
}): void {
  const endpoint =
    options?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    _tracer = new NoopTracerImpl()
    _exporter = null
    return
  }

  const serviceName =
    options?.serviceName ??
    process.env.OTEL_SERVICE_NAME ??
    'disciplr-backend'
  let samplingRate = options?.samplingRate ?? 1

  const sampler = process.env.OTEL_TRACES_SAMPLER
  if (sampler === 'always_off') {
    samplingRate = 0
  } else if (sampler === 'traceidratio') {
    const samplerArg = process.env.OTEL_TRACES_SAMPLER_ARG
    if (samplerArg !== undefined) {
      const parsed = parseFloat(samplerArg)
      // Guard against NaN / out-of-range — clamp to [0, 1]
      if (!Number.isNaN(parsed)) {
        samplingRate = Math.max(0, Math.min(1, parsed))
      }
    }
  }

  _exporter = new OTLPExporter(endpoint, serviceName)
  _tracer = new TracerImpl(_exporter, samplingRate)
}

/** Replace the tracer (for tests only). */
export function _setTracerForTesting(tracer: Tracer): void {
  _tracer = tracer
}

/** Reset to no-op (for tests). */
export function _resetTracingForTesting(): void {
  _tracer = new NoopTracerImpl()
  _exporter = null
}

/** Get the global tracer instance. */
export function getTracer(): Tracer {
  return _tracer
}

/** Check whether tracing is enabled (i.e. an endpoint is configured). */
export function isTracingEnabled(): boolean {
  return _exporter !== null
}

/** Flush any pending spans (e.g. during graceful shutdown). */
export async function flushTracing(): Promise<void> {
  if (_tracer instanceof TracerImpl) {
    await _tracer.flush()
  }
}

/** Shut down the tracer and flush remaining spans. */
export async function shutdownTracing(): Promise<void> {
  if (_tracer instanceof TracerImpl) {
    await _tracer.shutdown()
  }
}

export default {
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
}
