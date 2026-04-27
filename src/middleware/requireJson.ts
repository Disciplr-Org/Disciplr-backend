import { Request, Response, NextFunction } from 'express'

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
export const requireJson = (req: Request, res: Response, next: NextFunction) => {
  const bodylessMethods = ['GET', 'HEAD', 'OPTIONS']
  
  if (bodylessMethods.includes(req.method)) {
    return next()
  }

  const contentLength = req.headers['content-length']
  const transferEncoding = req.headers['transfer-encoding']
  const hasBody = (contentLength && parseInt(contentLength, 10) > 0) || 
                   (transferEncoding && transferEncoding.toLowerCase() !== 'identity')
  const contentType = req.headers['content-type']
  
  if (!contentType) {
    return res.status(415).json({
      error: 'Unsupported Media Type: Content-Type must be application/json'
    })
  }

  const normalizedContentType = contentType.toLowerCase().trim()
  
  if (!normalizedContentType.includes('application/json')) {
    return res.status(415).json({
      error: 'Unsupported Media Type: Content-Type must be application/json'
    })
  }

  if (normalizedContentType.includes('charset')) {
    const charsetMatch = normalizedContentType.match(/charset=([^;]+)/i)
    if (charsetMatch && charsetMatch[1].trim().toLowerCase() !== 'utf-8') {
      return res.status(415).json({
        error: 'Unsupported Media Type: Only UTF-8 charset is supported for JSON'
      })
    }
  }

  next()
}

/**
 * Middleware that enforces JSON content-type only for specific HTTP methods.
 * This is useful when you want to enforce content-type for POST/PUT but not DELETE.
 */
export const requireJsonForMethods = (methods: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!methods.includes(req.method)) {
      return next()
    }
    return requireJson(req, res, next)
  }
}
