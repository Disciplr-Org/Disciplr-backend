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
  // 413
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

// ─── Soroban Contract Error Catalog ──────────────────────────────────────────
export const SorobanErrorCatalog: Record<number, { code: ErrorCode; message: string; status: number }> = {
  1: { code: ErrorCode.CONFLICT, message: 'Already initialized', status: 409 },
  2: { code: ErrorCode.NOT_FOUND, message: 'Not initialized', status: 404 },
  3: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid amount', status: 400 },
  4: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid deadline', status: 400 },
  5: { code: ErrorCode.VALIDATION_ERROR, message: 'No milestones', status: 400 },
  6: { code: ErrorCode.CONFLICT, message: 'Not draft status', status: 409 },
  7: { code: ErrorCode.CONFLICT, message: 'Not active status', status: 409 },
  8: { code: ErrorCode.UNAUTHORIZED, message: 'Unauthorized', status: 401 },
  9: { code: ErrorCode.CONFLICT, message: 'Already staked', status: 409 },
  10: { code: ErrorCode.VALIDATION_ERROR, message: 'Milestone index out of range', status: 400 },
  11: { code: ErrorCode.CONFLICT, message: 'Milestone already verified', status: 409 },
  12: { code: ErrorCode.CONFLICT, message: 'Deadline passed', status: 409 },
  13: { code: ErrorCode.CONFLICT, message: 'Deadline not reached', status: 409 },
  14: { code: ErrorCode.CONFLICT, message: 'Milestones incomplete', status: 409 },
  15: { code: ErrorCode.CONFLICT, message: 'Nothing to withdraw', status: 409 },
  16: { code: ErrorCode.VALIDATION_ERROR, message: 'Amount mismatch', status: 400 },
}

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

  static unprocessable(message: string) {
    return new AppError(422, ErrorCode.UNPROCESSABLE, message)
  }

  static rateLimited(message = 'Too many requests') {
    return new AppError(429, ErrorCode.RATE_LIMITED, message)
  }

  static payloadTooLarge(message = 'Payload too large') {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, message)
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

  // Sanitize and convert express body-parser size limit errors
  if (err && typeof err === 'object' && 'status' in err && err.status === 413 && 'type' in err && (err as any).type === 'entity.too.large') {
    err = new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Payload too large')
  }

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
