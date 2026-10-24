import pino from 'pino'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

export const requestContext = new AsyncLocalStorage()

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  '*.signedXdr',
  '*.secret',
  'signedXdr',
  'secret',
]

export function createLogger(options = {}, destination) {
  const level = options.level || process.env.LOG_LEVEL || 'info'
  const redact = options.redact || REDACT_PATHS

  if (destination) {
    return pino({ level, redact, ...options }, destination)
  }
  return pino({ level, redact, ...options })
}

export const logger = createLogger()

export function isValidRequestId(id) {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > 64) return false
  // Safe token: alphanumeric, hyphens, underscores (no control chars / newlines)
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

export function generateRequestId() {
  return randomUUID()
}

export function resolveRoutePattern(req) {
  const baseUrl = req.baseUrl || ''
  const routePath = req.route?.path
  if (routePath) {
    return `${baseUrl}${routePath}`
  }
  return req.path || req.originalUrl?.split('?')[0] || 'unknown'
}

export function statementFingerprint(queryText) {
  if (typeof queryText !== 'string') return 'UNKNOWN'
  return queryText
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\$\d+/g, '?')
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
}

export function trackDbDuration(ms) {
  const store = requestContext.getStore()
  if (store && typeof store.dbDurationMs === 'number') {
    store.dbDurationMs += ms
  }
}

export function wrapPoolForTiming(pool, customLogger = logger) {
  if (!pool || pool._timingWrapped) return pool

  const slowQueryMs = parseInt(process.env.SLOW_QUERY_MS || '500', 10)

  const originalQuery = pool.query.bind(pool)
  pool.query = async function timedQuery(...args) {
    const start = process.hrtime.bigint()
    let queryText = ''
    if (typeof args[0] === 'string') {
      queryText = args[0]
    } else if (args[0] && typeof args[0].text === 'string') {
      queryText = args[0].text
    }

    try {
      return await originalQuery(...args)
    } finally {
      const end = process.hrtime.bigint()
      const durationMs = Number(end - start) / 1_000_000
      trackDbDuration(durationMs)

      if (durationMs >= slowQueryMs) {
        const fingerprint = statementFingerprint(queryText)
        const contextStore = requestContext.getStore()
        const reqLog = contextStore?.log || customLogger
        reqLog.warn(
          {
            slow_query: true,
            fingerprint,
            durationMs: Math.round(durationMs * 100) / 100,
            thresholdMs: slowQueryMs,
          },
          'Slow query detected'
        )
      }
    }
  }

  const originalConnect = pool.connect.bind(pool)
  pool.connect = async function timedConnect(...args) {
    const client = await originalConnect(...args)
    if (!client._timingWrapped) {
      const origClientQuery = client.query.bind(client)
      client.query = async function timedClientQuery(...qArgs) {
        const start = process.hrtime.bigint()
        let queryText = ''
        if (typeof qArgs[0] === 'string') {
          queryText = qArgs[0]
        } else if (qArgs[0] && typeof qArgs[0].text === 'string') {
          queryText = qArgs[0].text
        }

        try {
          return await origClientQuery(...qArgs)
        } finally {
          const end = process.hrtime.bigint()
          const durationMs = Number(end - start) / 1_000_000
          trackDbDuration(durationMs)

          if (durationMs >= slowQueryMs) {
            const fingerprint = statementFingerprint(queryText)
            const contextStore = requestContext.getStore()
            const reqLog = contextStore?.log || customLogger
            reqLog.warn(
              {
                slow_query: true,
                fingerprint,
                durationMs: Math.round(durationMs * 100) / 100,
                thresholdMs: slowQueryMs,
              },
              'Slow query detected'
            )
          }
        }
      }
      client._timingWrapped = true
    }
    return client
  }

  pool._timingWrapped = true
  return pool
}

export function requestIdMiddleware(rootLogger = logger) {
  return function (req, res, next) {
    const rawId = req.headers['x-request-id']
    const reqId = isValidRequestId(rawId) ? rawId : generateRequestId()

    req.id = reqId
    res.setHeader('x-request-id', reqId)

    const childLog = rootLogger.child({ reqId })
    req.log = childLog

    const startTime = process.hrtime.bigint()
    const context = {
      reqId,
      log: childLog,
      dbDurationMs: 0,
      startTime,
    }

    res.on('finish', () => {
      const endTime = process.hrtime.bigint()
      const totalDurationMs = Number(endTime - startTime) / 1_000_000
      const dbDurationMs = context.dbDurationMs || 0

      const route = resolveRoutePattern(req)
      const status = res.statusCode
      const method = req.method
      const storeKind = req.app?.locals?.storeKind || (process.env.DATABASE_URL ? 'postgres' : 'memory')

      const logData = {
        reqId,
        method,
        route,
        status,
        durationMs: Math.round(totalDurationMs * 100) / 100,
        store: storeKind,
      }

      if (status >= 500) {
        childLog.error(logData, 'HTTP request completed with error')
      } else if (status >= 400) {
        childLog.warn(logData, 'HTTP request completed with client error')
      } else {
        childLog.info(logData, 'HTTP request completed')
      }
    })

    // Add Server-Timing header before headers are written
    const origWriteHead = res.writeHead
    res.writeHead = function (...args) {
      if (!res.headersSent) {
        const curTotalMs = Number(process.hrtime.bigint() - startTime) / 1_000_000
        const curDbMs = context.dbDurationMs || 0
        const serverTiming = `db;dur=${curDbMs.toFixed(2)}, total;dur=${curTotalMs.toFixed(2)}`
        res.setHeader('Server-Timing', serverTiming)
      }
      return origWriteHead.apply(res, args)
    }

    requestContext.run(context, next)
  }
}
