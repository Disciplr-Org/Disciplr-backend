import pino, { Logger } from 'pino'
import { config } from '../config/index.js'

/**
 * Creates a configured Pino logger instance with:
 * - Automatic redaction of sensitive fields
 * - Pretty-printing in development
 * - Correlation ID support
 * - Structured JSON output for log aggregators
 *
 * Redacted paths cover:
 * - Authorization headers
 * - Passwords and tokens
 * - API keys and secrets
 * - Cookies
 * - Email addresses
 * - Vault-related sensitive data (creator, destinations)
 */
export function createLogger(): Logger {
  const isDev = config.nodeEnv === 'development'

  const pinoConfig: pino.LoggerOptions = {
    level: config.logLevel || 'info',
    base: {
      service: 'disciplr-backend',
    },
    // Redact sensitive paths from the entire log object
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.body.password',
        'req.body.token',
        'req.body.accessToken',
        'req.body.refreshToken',
        'req.body.apiKey',
        'req.body.api_key',
        'req.body.secret',
        'req.body.clientSecret',
        'req.body.creator',
        'req.body.successDestination',
        'req.body.failureDestination',
        'req.body.email',
        'res.headers.authorization',
        'res.headers.cookie',
        'res.headers["x-api-key"]',
        'err.authorization',
        'err.password',
        'err.token',
        'err.apiKey',
        'err.secret',
        'metadata.authorization',
        'metadata.password',
        'metadata.token',
        'metadata.apiKey',
        'metadata.secret',
        'user.email',
        'user.password',
        'user.apiKey',
        'vault.creator',
        'vault.successDestination',
        'vault.failureDestination',
      ],
      remove: false, // Replace with placeholder instead of removing
    },
    // Enable pretty printing in development
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: false,
            translateTime: 'SYS:standard',
            messageFormat: '{levelLabel} {msg}',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  }

  return pino(pinoConfig)
}

/**
 * Default logger instance
 */
export const logger = createLogger()

/**
 * Attach a correlation ID to logs within a scope
 */
export function withCorrelationId(
  logger: Logger,
  correlationId: string,
): Logger {
  return logger.child({ correlationId })
}

/**
 * Extract or generate a correlation ID from request headers
 */
export function getOrGenerateCorrelationId(
  req: any,
): string {
  return (
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  )
}
