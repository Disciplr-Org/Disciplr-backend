import { Request, Response, NextFunction } from 'express'
import { getTracer, parseTraceparent, serializeTraceparent, generateTraceId, generateSpanId, type TraceContext } from './tracing.js'

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
  const correlationId =
    (req.headers['x-correlation-id'] as string) ||
    (req.headers['x-request-id'] as string) ||
    traceCtx.traceId

  // ── Start server span ──
  const span = tracer.startSpan(
    `${req.method} ${req.route?.path ?? req.path}`,
    { traceId: traceCtx.traceId, spanId: traceCtx.spanId },
    {
      'http.method': req.method,
      'http.url': req.originalUrl,
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
  res.on('finish', () => {
    span.setAttribute('http.status_code', res.statusCode)
    span.setAttribute('http.response_content_length', Number(res.getHeader('content-length') ?? 0))

    if (res.statusCode >= 400) {
      span.setStatus({ code: 'ERROR', message: `HTTP ${res.statusCode}` })
    } else {
      span.setStatus({ code: 'OK' })
    }

    span.end()
  })

  next()
}

export default tracingMiddleware
