import type { NextFunction, Request, Response } from 'express'

// ─── Error Codes ─────────────────────────────────────────────────────────────
// Machine-readable codes clients can branch on without parsing message strings.
export const ErrorCode = {
  // 400
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  // 401
  UNAUTHORIZED: 'UNAUTHORIZED',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

// ─── Uniform error response shape ────────────────────────────────────────────
export interface ErrorResponse {
  error: {
    code: ErrorCode
    message: string
    /** Present only on validation errors – field-level detail, no PII */
    details?: unknown
    /** Echoed from the request for correlation */
    requestId?: string
  }
}

// ─── AppError ─────────────────────────────────────────────────────────────────
export class AppError extends Error {
  readonly status: number
  readonly code: ErrorCode
  /** Safe-to-expose detail (no stack traces, no PII) */
  readonly details?: unknown

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }

  // ── Convenience factories ──────────────────────────────────────────────────
  static badRequest(message: string, details?: unknown) {
    return new AppError(400, ErrorCode.BAD_REQUEST, message, details)
  }

  static validation(message: string, details?: unknown) {
    return new AppError(400, ErrorCode.VALIDATION_ERROR, message, details)
  }

  static unauthorized(message = 'Unauthorized') {
    return new AppError(401, ErrorCode.UNAUTHORIZED, message)
  }

  static forbidden(message = 'Forbidden') {
    return new AppError(403, ErrorCode.FORBIDDEN, message)
  }

  static notFound(message = 'Not found') {
    return new AppError(404, ErrorCode.NOT_FOUND, message)
  }

  static conflict(message: string) {
    return new AppError(409, ErrorCode.CONFLICT, message)
  }

  static internal(message = 'Internal server error') {
    return new AppError(500, ErrorCode.INTERNAL_ERROR, message)
  }
}

// ─── Express error-handler middleware ────────────────────────────────────────
// Must have the 4-argument signature so Express recognises it as an error handler.
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  // Structured log – no stack trace in the response, but captured here for ops.
  // PII is not logged: we only record method, path, and a sanitised message.
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? undefined

  if (err instanceof AppError) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'app_error',
        service: 'disciplr-backend',
        code: err.code,
        status: err.status,
        method: req.method,
        path: req.path,
        requestId,
        message: err.message,
        timestamp: new Date().toISOString(),
      }),
    )

    const body: ErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined && { details: err.details }),
        ...(requestId && { requestId }),
      },
    }

    res.status(err.status).json(body)
    return
  }

  // Unknown / unexpected errors – never leak internals to the client.
  const message = err instanceof Error ? err.message : 'Internal server error'

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'unhandled_error',
      service: 'disciplr-backend',
      method: req.method,
      path: req.path,
      requestId,
      // Only log the message, not the full stack, to avoid leaking internals in
      // structured log aggregators that forward to external services.
      message,
      timestamp: new Date().toISOString(),
    }),
  )

  const body: ErrorResponse = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
      ...(requestId && { requestId }),
    },
  }

  res.status(500).json(body)
}
