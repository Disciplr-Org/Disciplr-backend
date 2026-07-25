import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { AppError } from './errorHandler.js'

export interface RequireJsonOptions {
  maxBytes?: number
}

const bodylessMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

const parseContentLength = (contentLength: string | string[] | undefined): number | null => {
  if (Array.isArray(contentLength)) {
    return parseContentLength(contentLength[0])
  }

  if (!contentLength) {
    return null
  }

  const parsed = Number.parseInt(contentLength, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const buildRequireJsonMiddleware = (options: RequireJsonOptions = {}): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (bodylessMethods.has(req.method)) {
      return next()
    }

    const contentLength = parseContentLength(req.headers['content-length'])
    const hasBody = contentLength !== null && contentLength > 0

    if (!hasBody) {
      return next()
    }

    if (typeof options.maxBytes === 'number' && contentLength > options.maxBytes) {
      return next(AppError.payloadTooLarge())
    }

    const contentType = req.headers['content-type']

    if (!contentType) {
      return res.status(415).json({
        error: 'Unsupported Media Type: Content-Type must be application/json',
      })
    }

    const normalizedContentType = contentType.toLowerCase().trim()

    if (!normalizedContentType.includes('application/json')) {
      return res.status(415).json({
        error: 'Unsupported Media Type: Content-Type must be application/json',
      })
    }

    if (normalizedContentType.includes('charset')) {
      const charsetMatch = normalizedContentType.match(/charset=([^;]+)/i)
      if (charsetMatch && charsetMatch[1].trim().toLowerCase() !== 'utf-8') {
        return res.status(415).json({
          error: 'Unsupported Media Type: Only UTF-8 charset is supported for JSON',
        })
      }
    }

    return next()
  }
}

/**
 * Middleware that enforces Content-Type: application/json for requests with bodies.
 *
 * This middleware:
 * - Allows GET, HEAD, OPTIONS requests to pass through (no body expected)
 * - Requires Content-Type: application/json for POST, PUT, PATCH, DELETE requests with bodies
 * - Returns 415 Unsupported Media Type for invalid content types
 * - Returns 400 Bad Request for malformed JSON (handled by express.json() middleware)
 * - Preserves the existing error envelope format used throughout the application
 */
export function requireJson(req: Request, res: Response, next: NextFunction): void
export function requireJson(options?: RequireJsonOptions): RequestHandler
export function requireJson(
  reqOrOptions?: Request | RequireJsonOptions,
  res?: Response,
  next?: NextFunction,
): void | RequestHandler {
  if (res && next) {
    return buildRequireJsonMiddleware()(reqOrOptions as Request, res, next)
  }

  return buildRequireJsonMiddleware(reqOrOptions as RequireJsonOptions | undefined)
}

/**
 * Middleware that enforces JSON content-type only for specific HTTP methods.
 * This is useful when you want to enforce content-type for POST/PUT but not DELETE.
 */
export const requireJsonForMethods = (methods: string[], options?: RequireJsonOptions): RequestHandler => {
  const middleware = buildRequireJsonMiddleware(options)

  return (req: Request, res: Response, next: NextFunction) => {
    if (!methods.includes(req.method)) {
      return next()
    }
    return middleware(req, res, next)
  }
}
