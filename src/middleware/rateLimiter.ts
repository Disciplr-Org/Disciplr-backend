import rateLimit from 'express-rate-limit'
import type { Request, Response } from 'express'
import { recordRateLimitBreach } from './metrics.js'

export interface RateLimitConfig {
  windowMs: number
  max: number
  message?: string
  standardHeaders?: boolean
  legacyHeaders?: boolean
  skipSuccessfulRequests?: boolean
  keyGenerator?: (req: Request) => string
  handler?: (req: Request, res: Response) => void
}

const createRateLimiter = (config: Partial<RateLimitConfig> = {}) => {
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
      return apiKey ?? req.ip ?? req.socket.remoteAddress ?? 'unknown'
    }),
    handler: config.handler ?? ((req, res) => {
      const clientType = req.headers['x-api-key'] ? 'api_key' : 'ip'
      recordRateLimitBreach(req.route?.path || req.path, clientType)
      res.status(429).json({
        error: config.message ?? 'Too many requests, please try again later.',
        retryAfter: Math.ceil(windowMs / 1000),
      })
    }),
  })
}

export const defaultRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Rate limit exceeded. Please try again later.',
})

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts. Please try again later.',
})

export const healthRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Health check rate limit exceeded.',
})

export const vaultsRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many vault requests. Please try again later.',
})

export const strictRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Rate limit exceeded. This endpoint has strict rate limits.',
})

export { createRateLimiter }
