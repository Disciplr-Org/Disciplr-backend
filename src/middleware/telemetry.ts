import type { NextFunction, Request, Response } from 'express'

/**
 * Request telemetry for the hardened credential routers (auth, OAuth, API keys).
 *
 * The middleware records RED signals for these endpoints without ever touching
 * request bodies, headers, or query strings, so no credential material can ever
 * reach a metric label:
 *   - `disciplr_credential_endpoint_request_total{method,route,status_class}`
 *   - `disciplr_credential_endpoint_request_duration_ms{method,route}`
 *
 * Metrics are registered lazily against the shared Prometheus registry and
 * every failure path is swallowed, so importing a router in isolation (unit
 * tests without a metrics registry) stays a no-op rather than breaking the
 * request lifecycle. Route labels use the matched route pattern instead of the
 * raw URL to keep cardinality bounded and to avoid leaking path parameters.
 */

interface TelemetryCounter {
  inc: (labels: Record<string, string>) => void
}

interface TelemetryHistogram {
  observe: (value: number, labels: Record<string, string>) => void
}

let requestCounter: TelemetryCounter | null = null
let requestDuration: TelemetryHistogram | null = null
let telemetryReady = false
let telemetryPromise: Promise<void> | null = null

async function ensureTelemetryMetrics(): Promise<void> {
  if (telemetryReady) return
  if (telemetryPromise) return telemetryPromise

  telemetryPromise = (async () => {
    try {
      const client = await import('prom-client')
      const { register: metricsRegistry } = await import('../observability/metricsRegistry.js')
      requestCounter = new client.Counter({
        name: 'disciplr_credential_endpoint_request_total',
        help: 'Requests handled by the credential (auth/oauth/api-key) routers by status class',
        labelNames: ['method', 'route', 'status_class'],
        registers: [metricsRegistry],
      })
      requestDuration = new client.Histogram({
        name: 'disciplr_credential_endpoint_request_duration_ms',
        help: 'Latency of credential (auth/oauth/api-key) endpoints in milliseconds',
        labelNames: ['method', 'route'],
        buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
        registers: [metricsRegistry],
      })
    } catch {
      // Metrics unavailable (e.g. isolation tests without a registry) — no-op.
      requestCounter = { inc: () => {} }
      requestDuration = { observe: () => {} }
    } finally {
      telemetryReady = true
    }
  })()

  return telemetryPromise
}

const statusClass = (statusCode: number): string => {
  if (statusCode >= 500) return '5xx'
  if (statusCode >= 400) return '4xx'
  if (statusCode >= 300) return '3xx'
  return '2xx'
}

const routeLabel = (req: Request): string => {
  const pattern = (req.route as { path?: string } | undefined)?.path
  if (!pattern) return 'unmatched'
  return `${req.baseUrl ?? ''}${pattern}` || 'unmatched'
}

/**
 * Express middleware recording duration + outcome for credential endpoints.
 * Never throws and never blocks a request.
 */
export const requestTelemetry = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = process.hrtime.bigint()
  let recorded = false

  const record = (): void => {
    // Idempotent: 'finish' and 'close' can both fire (client disconnect).
    if (recorded) return
    recorded = true

    try {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      const route = routeLabel(req)
      void ensureTelemetryMetrics()
      requestCounter?.inc({ method: req.method, route, status_class: statusClass(res.statusCode) })
      requestDuration?.observe(durationMs, { method: req.method, route })
    } catch {
      // Telemetry failures must never propagate to the request lifecycle.
    }
  }

  res.on('finish', record)
  res.on('close', record)

  next()
}

export default requestTelemetry
