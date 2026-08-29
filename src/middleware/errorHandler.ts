import type { NextFunction, Request, Response } from 'express'
import { sanitizePrivacyPayload } from '../utils/privacy.js'

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
  // 415
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  // 422
  UNPROCESSABLE: 'UNPROCESSABLE',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // 502
  CONTRACT_ERROR_UNKNOWN: 'CONTRACT_ERROR_UNKNOWN',
  // 504
  SOROBAN_TIMEOUT: 'SOROBAN_TIMEOUT',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

// ─── Soroban Contract Error Catalog ──────────────────────────────────────────
export interface SorobanErrorMapping {
  code: ErrorCode
  message: string
  status: number
  retryable: boolean
}

export const SorobanErrorCatalog: Record<number, SorobanErrorMapping> = {
  1: { code: ErrorCode.CONFLICT, message: 'Already initialized', status: 409, retryable: false },
  2: { code: ErrorCode.NOT_FOUND, message: 'Not initialized', status: 404, retryable: false },
  3: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid amount', status: 400, retryable: false },
  4: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid deadline', status: 400, retryable: false },
  5: { code: ErrorCode.VALIDATION_ERROR, message: 'No milestones', status: 400, retryable: false },
  6: { code: ErrorCode.CONFLICT, message: 'Not draft status', status: 409, retryable: false },
  7: { code: ErrorCode.CONFLICT, message: 'Not active status', status: 409, retryable: false },
  8: { code: ErrorCode.UNAUTHORIZED, message: 'Unauthorized', status: 401, retryable: false },
  9: { code: ErrorCode.CONFLICT, message: 'Already staked', status: 409, retryable: false },
  10: { code: ErrorCode.VALIDATION_ERROR, message: 'Milestone index out of range', status: 400, retryable: false },
  11: { code: ErrorCode.CONFLICT, message: 'Milestone already verified', status: 409, retryable: false },
  12: { code: ErrorCode.CONFLICT, message: 'Deadline passed', status: 409, retryable: false },
  13: { code: ErrorCode.CONFLICT, message: 'Deadline not reached', status: 409, retryable: false },
  14: { code: ErrorCode.CONFLICT, message: 'Milestones incomplete', status: 409, retryable: false },
  15: { code: ErrorCode.CONFLICT, message: 'Nothing to withdraw', status: 409, retryable: false },
  16: { code: ErrorCode.VALIDATION_ERROR, message: 'Amount mismatch', status: 400, retryable: false },
  23: { code: ErrorCode.UNAUTHORIZED, message: 'Only creator can perform this action', status: 401, retryable: false },
  24: { code: ErrorCode.UNAUTHORIZED, message: 'Only verifier can perform this action', status: 401, retryable: false },
  25: { code: ErrorCode.UNAUTHORIZED, message: 'Only creator or verifier can perform this action', status: 401, retryable: false },
  28: { code: ErrorCode.VALIDATION_ERROR, message: 'Deadline is in the past', status: 400, retryable: false },
}

// ─── Uniform error response shape ────────────────────────────────────────────
export interface ErrorResponse {
  error: {
    code: ErrorCode
    message: string
    /** Present only on validation errors – field-level detail, no PII */
    details?: unknown
    /** Whether a client may safely retry the failed operation. */
    retryable?: boolean
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
  /** Explicit retry guidance for errors originating from a contract. */
  readonly retryable?: boolean

  constructor(status: number, code: ErrorCode, message: string, details?: unknown, retryable?: boolean) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    this.retryable = retryable
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

  static unsupportedMediaType(message = 'Content-Type must be application/json') {
    return new AppError(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, message)
  }

  /**
   * Converts a Soroban contract rejection into a typed, user-safe error.
   * Unknown contract codes intentionally fail closed instead of returning raw
   * RPC text to clients.
   */
  static fromContractError(err: unknown): AppError | null {
    const codeInt = extractContractErrorCode(err)
    if (codeInt === null) return null

    const mapping = SorobanErrorCatalog[codeInt]
    if (!mapping) {
      return new AppError(
        502,
        ErrorCode.CONTRACT_ERROR_UNKNOWN,
        'Contract operation failed',
        { contractErrorCode: codeInt },
        false,
      )
    }

    return new AppError(mapping.status, mapping.code, mapping.message, { contractErrorCode: codeInt }, mapping.retryable)
  }
}

/** Extract only explicitly Soroban-shaped numeric codes; generic RPC `code` fields are ignored. */
function extractContractErrorCode(err: unknown): number | null {
  const candidates: unknown[] = [err]
  if (err && typeof err === 'object') {
    const value = err as Record<string, unknown>
    candidates.push(value.message, value.error, value.result, value.data)
    if (typeof value.contractErrorCode === 'number') candidates.push(`ContractError(${value.contractErrorCode})`)
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const match = candidate.match(/Error\s*\(\s*Contract\s*,\s*(\d+)\s*\)/i) || candidate.match(/ContractError\s*\(\s*(\d+)\s*\)/i)
    if (!match) continue
    const code = Number(match[1])
    if (Number.isSafeInteger(code)) return code
  }

  return null
}

/**
 * Thrown when the Soroban transaction status polling deadline is exceeded.
 * Maps to HTTP 504 Gateway Timeout.
 */
export class SorobanTimeoutError extends Error {
  readonly code = ErrorCode.SOROBAN_TIMEOUT
  readonly status = 504
  readonly txHash: string
  readonly elapsedMs: number

  constructor(txHash: string, elapsedMs: number) {
    super(`Soroban transaction ${txHash} did not finalise within ${elapsedMs}ms`)
    this.name = 'SorobanTimeoutError'
    this.txHash = txHash
    this.elapsedMs = elapsedMs
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

  // Determine if we are in a production environment
  const isProduction = process.env.NODE_ENV === 'production'

  // Sanitize any echoed PII from error details in production
  const sanitizeDetails = (details: unknown) =>
    isProduction ? sanitizePrivacyPayload(details) : details

  // Sanitize and convert express body-parser size limit errors
  if (err && typeof err === 'object' && 'status' in err && err.status === 413 && 'type' in err && (err as any).type === 'entity.too.large') {
    err = new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Payload too large')
  }

  if (err instanceof SorobanTimeoutError) {
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
        details: sanitizeDetails({ txHash: err.txHash, elapsedMs: err.elapsedMs }),
        ...(requestId && { requestId }),
      },
    }

    res.status(err.status).json(body)
    return
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
        ...(err.retryable !== undefined && { retryable: err.retryable }),
        timestamp: new Date().toISOString(),
      }),
    )

    const body: ErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined && { details: sanitizeDetails(err.details) }),
        ...(err.retryable !== undefined && { retryable: err.retryable }),
        ...(requestId && { requestId }),
      },
    }

    res.status(err.status).json(body)
    return
  }

  // Unknown / unexpected errors – never leak internals to the client.
  // In production, always use a generic message. In dev, show the real error.
  const responseMessage = 'Internal server error'
  const logMessage = isProduction
    ? responseMessage
    : err instanceof Error ? err.message : responseMessage

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
      message: logMessage,
      timestamp: new Date().toISOString(),
    }),
  )

  const body: ErrorResponse = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: responseMessage,
      ...(requestId && { requestId }),
    },
  }

  res.status(500).json(body)
}
