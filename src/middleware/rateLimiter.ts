import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request, Response, NextFunction } from 'express'
import { redactApiKeyForLogs } from '../services/apiKeys.js'
import { getEnv } from '../config/index.js'
import Redis from 'ioredis'
import { RedisStore } from './rateLimitStore.js'

export interface RateLimitConfig {
  windowMs: number
  max: number
  message?: string
  prefix?: string
  standardHeaders?: boolean
  legacyHeaders?: boolean
  skipSuccessfulRequests?: boolean
  keyGenerator?: (req: Request) => string
  handler?: (req: Request, res: Response) => void
}

const logRateLimitBreached = (req: Request): void => {
  const timestamp = new Date().toISOString()
  const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const method = req.method
  const path = req.path
  const userAgent = req.headers['user-agent'] ?? 'unknown'
  const apiKeyHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined
  const apiKey = redactApiKeyForLogs(apiKeyHeader)

  console.warn(`[RATE_LIMIT_BREACH] ${timestamp} | IP: ${clientIp} | API_KEY: ${apiKey} | ${method} ${path} | User-Agent: ${userAgent}`)
}

/** Normalize an IP string for use as a rate-limit key, handling IPv6 subnets. */
const normalizeIp = (req: Request): string =>
  ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown')

let sharedRedisClient: Redis | undefined

const getRedisClient = (): Redis | undefined => {
  if (sharedRedisClient !== undefined) return sharedRedisClient

  try {
    const env = getEnv()
    const redisUrl = env.REDIS_URL
    if (redisUrl) {
      sharedRedisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      })
      return sharedRedisClient
    }
  } catch {
    const redisUrl = process.env.REDIS_URL
    if (redisUrl) {
      sharedRedisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      })
      return sharedRedisClient
    }
  }
  return undefined
}

const createRateLimiter = (config: Partial<RateLimitConfig> = {}) => {
  const windowMs = config.windowMs ?? 15 * 60 * 1000
  const max = config.max ?? 100
  const prefix = config.prefix ?? 'default:'
  const redisClient = getRedisClient()

  return rateLimit({
    windowMs,
    max,
    store: redisClient ? new RedisStore(redisClient, `rl:${prefix}`) : undefined,
    standardHeaders: config.standardHeaders ?? true,
    legacyHeaders: config.legacyHeaders ?? false,
    skipSuccessfulRequests: config.skipSuccessfulRequests ?? false,
    keyGenerator: config.keyGenerator ?? ((req) => {
      const apiKey = req.headers['x-api-key'] as string | undefined
      const orgId = (req as any).orgId
      if (orgId) {
        return `org:${orgId}:${apiKey ?? normalizeIp(req)}`
      }
      return apiKey ?? normalizeIp(req)
    }),
  })
}

export const defaultRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Rate limit exceeded. Please try again later.',
  prefix: 'default:',
})

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts. Please try again later.',
  prefix: 'auth:',
})

export const healthRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Health check rate limit exceeded.',
  prefix: 'health:',
})

export const vaultsRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many vault requests. Please try again later.',
  prefix: 'vaults:',
})

export const strictRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Rate limit exceeded. This endpoint has strict rate limits.',
  prefix: 'strict:',
})

export const metricsRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Metrics endpoint rate limit exceeded. Please try again later.',
  prefix: 'metrics:',
})

export const apiKeyRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many API key management requests. Please try again later.',
  prefix: 'apikey:',
})

let orgRead: any
export const orgReadRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  if (!orgRead) {
    let max = 200
    let windowMs = 60000
    try {
      const env = getEnv()
      max = env.ORG_RATE_LIMIT_MAX
      windowMs = env.ORG_RATE_LIMIT_WINDOW_MS
    } catch {
      max = process.env.ORG_RATE_LIMIT_MAX ? Number(process.env.ORG_RATE_LIMIT_MAX) : 200
      windowMs = process.env.ORG_RATE_LIMIT_WINDOW_MS ? Number(process.env.ORG_RATE_LIMIT_WINDOW_MS) : 60000
    }
    orgRead = createRateLimiter({
      windowMs,
      max,
      message: 'Organization read rate limit exceeded.',
      prefix: 'orgRead:',
    })
  }
  return orgRead(req, res, next)
}

let orgWrite: any
export const orgWriteRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  if (!orgWrite) {
    let max = 200
    let windowMs = 60000
    try {
      const env = getEnv()
      max = env.ORG_RATE_LIMIT_MAX
      windowMs = env.ORG_RATE_LIMIT_WINDOW_MS
    } catch {
      max = process.env.ORG_RATE_LIMIT_MAX ? Number(process.env.ORG_RATE_LIMIT_MAX) : 200
      windowMs = process.env.ORG_RATE_LIMIT_WINDOW_MS ? Number(process.env.ORG_RATE_LIMIT_WINDOW_MS) : 60000
    }
    orgWrite = createRateLimiter({
      windowMs,
      max,
      message: 'Organization write rate limit exceeded.',
      prefix: 'orgWrite:',
    })
  }
  return orgWrite(req, res, next)
}

let orgAnalytics: any
export const orgAnalyticsRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  if (!orgAnalytics) {
    let max = 200
    let windowMs = 60000
    try {
      const env = getEnv()
      max = env.ORG_RATE_LIMIT_MAX
      windowMs = env.ORG_RATE_LIMIT_WINDOW_MS
    } catch {
      max = process.env.ORG_RATE_LIMIT_MAX ? Number(process.env.ORG_RATE_LIMIT_MAX) : 200
      windowMs = process.env.ORG_RATE_LIMIT_WINDOW_MS ? Number(process.env.ORG_RATE_LIMIT_WINDOW_MS) : 60000
    }
    orgAnalytics = createRateLimiter({
      windowMs,
      max,
      message: 'Organization analytics rate limit exceeded.',
      prefix: 'orgAnalytics:',
    })
  }
  return orgAnalytics(req, res, next)
}

// Ensure the Redis client can be properly closed
export const closeRateLimiterStore = async () => {
  if (sharedRedisClient) {
    await sharedRedisClient.quit()
    sharedRedisClient = undefined
  }
}

export { createRateLimiter }
