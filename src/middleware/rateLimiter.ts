import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request, RequestHandler, Response } from 'express'

export interface RateLimitConfig {
  profile?: RateLimitProfile
  windowMs: number
  max: number
  message?: string
  standardHeaders?: boolean
  legacyHeaders?: boolean
  skipSuccessfulRequests?: boolean
  keyGenerator?: (req: Request) => string
  handler?: (req: Request, res: Response) => void
}

type RateLimitProfile = 'default' | 'auth' | 'health' | 'vaults' | 'strict' | 'analytics' | 'mutation'

type RateLimitMetrics = Record<RateLimitProfile, number>

const rateLimitMetrics: RateLimitMetrics = {
  default: 0,
  auth: 0,
  health: 0,
  vaults: 0,
  strict: 0,
  analytics: 0,
  mutation: 0,
}

const parsePositiveIntegerEnv = (name: string, fallback: number): number => {
  const rawValue = process.env[name]

  if (!rawValue) {
    return fallback
  }

  const parsedValue = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback
  }

  return parsedValue
}

const incrementRateLimitMetric = (profile: RateLimitProfile): void => {
  rateLimitMetrics[profile] += 1
}

const logRateLimitBreached = (
  req: Request,
  profile: RateLimitProfile,
  windowMs: number,
  max: number,
): void => {
  incrementRateLimitMetric(profile)

  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'security.rate_limit_triggered',
      service: 'disciplr-backend',
      profile,
      method: req.method,
      path: req.originalUrl || req.path,
      identifierSource: typeof req.headers['x-api-key'] === 'string' ? 'api-key' : 'ip',
      windowMs,
      threshold: max,
      timestamp: new Date().toISOString(),
    }),
  )
}

const createRateLimiter = (config: Partial<RateLimitConfig> = {}) => {
  const profile = config.profile ?? 'default'
  const windowMs = config.windowMs ?? 15 * 60 * 1000
  const max = config.max ?? 100

  return rateLimit({
    windowMs,
    max,
    standardHeaders: config.standardHeaders ?? true,
    legacyHeaders: config.legacyHeaders ?? false,
    skipSuccessfulRequests: config.skipSuccessfulRequests ?? false,
    keyGenerator: config.keyGenerator ?? ((req) => {
      const apiKey = req.headers['x-api-key'] as string | undefined
      if (apiKey) {
        return apiKey
      }

      return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown')
    }),
    handler: config.handler ?? ((req, res) => {
      logRateLimitBreached(req, profile, windowMs, max)
      res.status(429).json({
        error: config.message ?? 'Too many requests, please try again later.',
        retryAfter: Math.ceil(windowMs / 1000),
      })
    }),
  })
}

const createMethodScopedRateLimiter = (
  methods: readonly string[],
  limiter: RequestHandler,
): RequestHandler => {
  const allowedMethods = new Set(methods.map((method) => method.toUpperCase()))

  return (req, res, next) => {
    if (!allowedMethods.has(req.method.toUpperCase())) {
      next()
      return
    }

    limiter(req, res, next)
  }
}

export const getRateLimitMetricsSnapshot = (): RateLimitMetrics => ({ ...rateLimitMetrics })

export const defaultRateLimiter = createRateLimiter({
  profile: 'default',
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Rate limit exceeded. Please try again later.',
})

export const authRateLimiter = createRateLimiter({
  profile: 'auth',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts. Please try again later.',
})

export const healthRateLimiter = createRateLimiter({
  profile: 'health',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Health check rate limit exceeded.',
})

export const vaultsRateLimiter = createRateLimiter({
  profile: 'vaults',
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many vault requests. Please try again later.',
})

export const strictRateLimiter = createRateLimiter({
  profile: 'strict',
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Rate limit exceeded. This endpoint has strict rate limits.',
})

export const analyticsRateLimiter = createRateLimiter({
  profile: 'analytics',
  windowMs: parsePositiveIntegerEnv('ANALYTICS_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  max: parsePositiveIntegerEnv('ANALYTICS_RATE_LIMIT_MAX', 120),
  message: 'Rate limit exceeded. Too many analytics requests. Please try again later.',
})

export const mutationRateLimiter = createMethodScopedRateLimiter(
  ['POST', 'PUT', 'PATCH', 'DELETE'],
  createRateLimiter({
    profile: 'mutation',
    windowMs: parsePositiveIntegerEnv('MUTATION_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    max: parsePositiveIntegerEnv('MUTATION_RATE_LIMIT_MAX', 40),
    message: 'Rate limit exceeded. Too many mutation requests. Please try again later.',
  }),
)

export { createMethodScopedRateLimiter, createRateLimiter }
