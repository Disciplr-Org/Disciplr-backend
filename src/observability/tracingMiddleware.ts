import { Request, Response, NextFunction } from 'express'
import { getTracer, parseTraceparent, serializeTraceparent, generateTraceId, generateSpanId, type TraceContext } from './tracing.js'
import { transitionOperation, isTerminal } from './observabilityState.js'

/**
 * Augmented Express Request carrying trace context.
 */
export interface TracedRequest extends Request {
  traceContext?: TraceContext
  correlationId?: string
  span?: ReturnType<ReturnType<typeof getTracer>['startSpan']>
}

/**
 * Express middleware that:
 * 1. Extracts or creates a W3C traceparent context
 * 2. Starts a server span for the request lifecycle
 * 3. Attaches the trace context + correlation ID to the request
 * 4. Injects the outgoing traceparent header on the response
 * 5. Records HTTP method, route, and status code as span attributes
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tracer = getTracer()
  const excludedPaths = ['/api/metrics', '/health', '/ready']

  // Skip tracing for excluded paths (still allow downstream to work)
  if (excludedPaths.some((p) => req.path.startsWith(p))) {
    return next()
  }

  // ── Extract or create trace context ──
  const incomingTraceparent = req.headers['traceparent'] as string | undefined
  let traceCtx: TraceContext | null = incomingTraceparent
    ? parseTraceparent(incomingTraceparent)
    : null

  if (!traceCtx) {
    traceCtx = { traceId: generateTraceId(), spanId: generateSpanId(), traceFlags: '01' }
  }

  // ── Correlation ID ──
  const rawCorrelationId = (req.headers['x-correlation-id'] as string) || (req.headers['x-request-id'] as string)
  let correlationId = traceCtx.traceId
  
  if (rawCorrelationId && typeof rawCorrelationId === 'string') {
    // Validate correlation ID: only allow reasonable alphanumeric/uuid values, max 100 chars.
    // Explicitly reject strings matching Stellar wallet addresses (G or M followed by 55 alphanumeric characters)
    // to prevent adversarial injection of wallet identities into traces.
    if (!/^[GM][A-Z2-7]{55}$/.test(rawCorrelationId) && /^[a-zA-Z0-9\-_]{1,100}$/.test(rawCorrelationId)) {
      correlationId = rawCorrelationId
    }
  }

  // Mark tracing as in-progress
  transitionOperation(req, 'tracing', 'in_progress')

  // ── Start server span ──
  const span = tracer.startSpan(
    `${req.method} ${req.route?.path ?? req.path}`,
    { traceId: traceCtx.traceId, spanId: traceCtx.spanId },
    {
      'http.method': req.method,
      'http.url': (req.originalUrl || req.url).split('?')[0],
      'http.target': req.path,
      'http.host': req.hostname,
      'http.scheme': req.protocol,
      'http.user_agent': req.headers['user-agent'] ?? '',
      'correlation.id': correlationId,
      'net.peer.ip': req.ip ?? '',
    },
  )

  // ── Attach to request ──
  const tracedReq = req as TracedRequest
  tracedReq.traceContext = { traceId: traceCtx.traceId, spanId: span.spanId, traceFlags: '01' }
  tracedReq.correlationId = correlationId
  tracedReq.span = span

  // ── Inject outgoing traceparent ──
  const outgoingTraceparent = serializeTraceparent({
    traceId: traceCtx.traceId,
    spanId: span.spanId,
    traceFlags: '01',
  })
  res.setHeader('traceparent', outgoingTraceparent)

  // ── Record response metrics on finish ──
  // Wrapped in try/catch so that a failure in attribute setting or
  // span.end() never leaves the span in a dangling (un-ended) state.
  // The span.end() call is idempotent — calling it twice is safe.
  res.on('finish', () => {
    try {
      span.setAttribute('http.status_code', res.statusCode)
      span.setAttribute('http.response_content_length', Number(res.getHeader('content-length') ?? 0))

      if (res.statusCode >= 400) {
        span.setStatus({ code: 'ERROR', message: `HTTP ${res.statusCode}` })
      } else {
        span.setStatus({ code: 'OK' })
      }
    } catch {
      // If attribute setting fails, record the failure as a span event
      // but still attempt to end the span to prevent resource leaks.
      try {
        span.addEvent('span.finish.error', { error: 'setAttribute failed' })
      } catch { /* best-effort */ }
    }

    // Always end the span — even if attribute setting failed.
    // span.end() is idempotent (safe to call multiple times).
    span.end()
    transitionOperation(req, 'tracing', 'done')
  })

  next()
}

export default tracingMiddleware
