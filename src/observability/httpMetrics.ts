import type { NextFunction, Request, Response } from 'express'
import { Counter, Histogram, Registry } from 'prom-client'

const registry = new Registry()

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
  registers: [registry],
})

const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, +Infinity],
  registers: [registry],
})

const excludedPaths = ['/api/metrics', '/api/health', '/health', '/ready']

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint()

  res.on('finish', () => {
    const path = req.path
    const shouldExclude = excludedPaths.some((excludedPath) => path.startsWith(excludedPath))

    if (shouldExclude) {
      return
    }

    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6
    const statusCode = res.statusCode.toString()

    httpRequestsTotal.inc({ method: req.method, path, status_code: statusCode })
    httpRequestDurationSeconds.observe(
      { method: req.method, path, status_code: statusCode },
      durationMs / 1000,
    )
  })

  next()
}

export const httpMetricsRegister = registry

export function __resetHttpMetricsForTests(): void {
  registry.resetMetrics()
}
