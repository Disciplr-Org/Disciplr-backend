import type { NextFunction, Request, Response } from 'express'
import { timingSafeEqual } from 'crypto'
import { logger, withCorrelationId, getOrGenerateCorrelationId } from './logger.js'
import { getEnv } from '../config/env.js'

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
type LogLevel = typeof LOG_LEVELS[number]

function isLogLevel(v: string): v is LogLevel {
  return LOG_LEVELS.includes(v as LogLevel)
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function parseStatusSet(raw: string): Set<number> {
  return new Set(
    raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n)),
  )
}

/**
 * Request logging middleware using Pino for structured JSON output.
 *
 * Emits a single JSON line per request with:
 * - Correlation ID (extracted from headers or generated)
 * - Request method, URL, query parameters
 * - Response status code and duration
 * - Request size (if available)
 * - User ID (if available from headers)
 *
 * Supports tail-based log sampling:
 * - Errors (>=500), slow requests (>LOG_SLOW_THRESHOLD_MS), and
 *   statuses in LOG_ALWAYS_LOG_STATUS are always logged.
 * - All other requests are logged at LOG_SAMPLE_RATE (0.0–1.0).
 *
 * Admin debug overrides (requires ADMIN_API_KEY to be set):
 * - x-debug-trace: <ADMIN_API_KEY> forces debug-level logging.
 * - x-log-level: <level> overrides the log level when x-admin-key
 *   matches ADMIN_API_KEY.
 *
 * All sensitive fields are automatically redacted by Pino's redact configuration.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()
  const correlationId = getOrGenerateCorrelationId(req)
  const requestLogger = withCorrelationId(logger, correlationId)

  const method = req.method
  const url = req.originalUrl
  const path = req.path
  const queryString = req.url.includes('?') ? req.url.split('?')[1] : undefined
  const userId = req.headers['x-user-id'] as string | undefined
  const userRole = req.headers['x-user-role'] as string | undefined
  const contentLength = req.headers['content-length']

  ;(req as any).correlationId = correlationId
  ;(req as any).logger = requestLogger

  res.on('finish', () => {
    const durationMs = Date.now() - start
    const statusCode = res.statusCode

    let logLevel: LogLevel =
      statusCode >= 500 ? 'error' :
      statusCode >= 400 ? 'warn' :
      statusCode >= 200 ? 'info' :
      'debug'

    let forceLog = false
    const env = getEnv()

    if (env.ADMIN_API_KEY) {
      const debugTrace = req.headers['x-debug-trace'] as string | undefined
      if (debugTrace && constantTimeCompare(debugTrace, env.ADMIN_API_KEY)) {
        logLevel = 'debug'
        forceLog = true
      }

      const logLevelHeader = req.headers['x-log-level'] as string | undefined
      const adminKeyHeader = req.headers['x-admin-key'] as string | undefined
      if (
        logLevelHeader &&
        adminKeyHeader &&
        constantTimeCompare(adminKeyHeader, env.ADMIN_API_KEY) &&
        isLogLevel(logLevelHeader)
      ) {
        logLevel = logLevelHeader
        forceLog = true
      }
    }

    if (!forceLog) {
      const isError = statusCode >= 500
      const isSlow = durationMs >= env.LOG_SLOW_THRESHOLD_MS
      const importantStatuses = parseStatusSet(env.LOG_ALWAYS_LOG_STATUS)
      const sampled = isError || isSlow || importantStatuses.has(statusCode) || Math.random() < env.LOG_SAMPLE_RATE
      if (!sampled) return
    }

    requestLogger[logLevel](
      {
        event: 'http.request',
        req: {
          method,
          url,
          path,
          queryString,
          headers: req.headers,
          body: req.body,
          contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
          userId,
          userRole,
        },
        res: {
          statusCode,
          headers: res.getHeaders(),
        },
        durationMs,
      },
      `${method} ${path} ${statusCode} ${durationMs}ms`,
    )
  })

  next()
}
