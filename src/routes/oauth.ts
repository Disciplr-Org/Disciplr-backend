import { Router, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { validateApiKey } from '../services/apiKeys.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { requireJson } from '../middleware/requireJson.js'
import { authRateLimiter } from '../middleware/rateLimiter.js'
import { getEnv } from '../config/index.js'
import type { ApiScope } from '../types/auth.js'
import { requestTelemetry } from '../middleware/telemetry.js'
import { getNetworkId } from '../middleware/oauthBearer.js'

export const oauthRouter = Router()
oauthRouter.use(requestTelemetry)

const DEFAULT_TOKEN_TTL_SECONDS = 3600
const MIN_TOKEN_TTL_SECONDS = 60
const MAX_TOKEN_TTL_SECONDS = 12 * 60 * 60
const MAX_SCOPES_PER_REQUEST = 20
const MAX_SCOPE_LENGTH = 64
/** Upper bound for the raw `scope` string, rejected as a malformed request. */
const MAX_REQUESTED_SCOPE_CHARS = 256

/**
 * Resolve how long an issued access token lives, in seconds.
 *
 * OAUTH_TOKEN_TTL_SECONDS is operator-supplied, so anything that is not an
 * integer inside [MIN, MAX] falls back to the 1 hour default rather than
 * silently minting a token with an unintended (possibly indefinite) lifetime.
 */
export const resolveTokenTtlSeconds = (): number => {
  const raw = process.env.OAUTH_TOKEN_TTL_SECONDS
  if (!raw) {
    return DEFAULT_TOKEN_TTL_SECONDS
  }

  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    return DEFAULT_TOKEN_TTL_SECONDS
  }

  if (parsed < MIN_TOKEN_TTL_SECONDS || parsed > MAX_TOKEN_TTL_SECONDS) {
    return DEFAULT_TOKEN_TTL_SECONDS
  }

  return parsed
}

/**
 * RFC 6749 §4.4 client_credentials token request.
 * `client_id` is the UUID of the API key bound to the presented secret, so a
 * non-UUID value can be rejected as `invalid_request` before any lookup.
 */
export const oauthTokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().trim().uuid('client_id must be a UUID.'),
  client_secret: z.string().min(1, 'client_secret is required.').max(512),
  scope: z.string().max(MAX_REQUESTED_SCOPE_CHARS).optional(),
})

const oauthJson = requireJson({ maxBytes: 16384 })

/**
 * Retrieve the JWT secret from validated configuration.
 * Fails closed in production if the secret is unset or matches known insecure default sentinels.
 */
export const getOAuthJwtSecret = (): string => {
  let secret: string | undefined
  try {
    secret = getEnv().JWT_SECRET
  } catch {
    secret = process.env.JWT_SECRET
  }

  const isProduction =
    process.env.NODE_ENV === 'production' ||
    (() => {
      try {
        return getEnv().NODE_ENV === 'production'
      } catch {
        return false
      }
    })()

  if (
    isProduction &&
    (!secret ||
      secret === 'change-me-in-production-long-secret' ||
      secret === 'change-me-in-production')
  ) {
    throw new Error('JWT_SECRET is unset or using an insecure default value in production')
  }

  if (!secret) {
    throw new Error('JWT_SECRET is not configured')
  }

  return secret
}

/** Non-blocking audit log helper — failures are logged but never propagate. */
const auditLog = (entry: Parameters<typeof createAuditLog>[0]): void => {
  createAuditLog(entry).catch((err) => {
    console.error(JSON.stringify({ level: 'error', event: 'oauth.audit_log_failed', error: String(err) }))
  })
}

/** RFC 6749 §5.2 error response */
const oauthError = (res: Response, status: number, error: string, description: string): void => {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .set('Pragma', 'no-cache')
    .json({ error, error_description: description })
}

oauthRouter.post('/token', oauthJson, authRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawBody = (req.body ?? {}) as Record<string, unknown>

  // RFC 6749 §5.2 — an unsupported/missing grant_type is reported distinctly.
  if (rawBody.grant_type !== 'client_credentials') {
    oauthError(res, 400, 'unsupported_grant_type', 'Only client_credentials is supported')
    return
  }

  const parsed = oauthTokenRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    auditLog({
      actor_user_id: String(rawBody.client_id ?? 'unknown'),
      action: 'oauth.token_denied',
      target_type: 'oauth_client',
      target_id: String(rawBody.client_id ?? 'unknown'),
      metadata: { reason: 'invalid_request', grant_type: 'client_credentials' },
    })
    oauthError(res, 400, 'invalid_request', 'Malformed token request')
    return
  }

  const { client_id, client_secret, scope } = parsed.data

  const result = await validateApiKey(client_secret)

  if (!result.valid) {
    auditLog({
      actor_user_id: client_id,
      action: 'oauth.token_denied',
      target_type: 'oauth_client',
      target_id: client_id,
      metadata: { reason: result.reason, grant_type: 'client_credentials' },
    })
    oauthError(res, 401, 'invalid_client', 'Invalid client credentials')
    return
  }

  const canonicalClientId = result.context.apiKeyId

  // The presented client_id MUST match the id bound to the verified secret —
  // never trust the client-supplied identifier alone.
  if (client_id !== canonicalClientId) {
    auditLog({
      actor_user_id: canonicalClientId,
      action: 'oauth.token_denied',
      target_type: 'oauth_client',
      target_id: canonicalClientId,
      metadata: { reason: 'client_id_mismatch', grant_type: 'client_credentials', presented_client_id: client_id },
    })
    oauthError(res, 401, 'invalid_client', 'Invalid client credentials')
    return
  }

  const clientScopes: ApiScope[] = result.context.scopes
  const requestedScopes = typeof scope === 'string'
    ? (Array.from(
        new Set(
          scope
            .split(/\s+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ) as ApiScope[])
    : []

  // RFC 6749 §4.4.3: an omitted/blank `scope` means "all scopes the client was
  // granted", so a whitespace-only value must not collapse to an empty grant.
  let grantedScopes: ApiScope[]

  if (requestedScopes.length > 0) {
    const requested = requestedScopes

    if (requested.length > MAX_SCOPES_PER_REQUEST) {
      auditLog({
        actor_user_id: canonicalClientId,
        action: 'oauth.token_denied',
        target_type: 'oauth_client',
        target_id: canonicalClientId,
        metadata: { reason: 'scope_limit_exceeded', requested_scopes: requested },
      })
      oauthError(res, 400, 'invalid_scope', `Requested scope count exceeds limit of ${MAX_SCOPES_PER_REQUEST}`)
      return
    }

    const invalidLength = requested.find((s) => s.length > MAX_SCOPE_LENGTH)
    if (invalidLength) {
      auditLog({
        actor_user_id: canonicalClientId,
        action: 'oauth.token_denied',
        target_type: 'oauth_client',
        target_id: canonicalClientId,
        metadata: { reason: 'scope_length_exceeded', invalid_scope: invalidLength },
      })
      oauthError(res, 400, 'invalid_scope', `Scope '${invalidLength}' exceeds maximum length of ${MAX_SCOPE_LENGTH}`)
      return
    }

    if (requested.length === 0) {
      // RFC 6749 §4.4.3 — an empty/whitespace-only scope request means "no
      // specific scopes requested", so the full client grant applies.
      grantedScopes = clientScopes
    } else {
      // Deduplicate before comparison so duplicate scope strings cannot be used
      // to bypass capabilities or pollute the minted token.
      const unique = Array.from(new Set(requested))

      const unknown = unique.filter((s) => !clientScopes.includes(s))
      if (unknown.length > 0) {
        auditLog({
          actor_user_id: canonicalClientId,
          action: 'oauth.token_denied',
          target_type: 'oauth_client',
          target_id: canonicalClientId,
          metadata: { reason: 'scope_exceeded', requested_scopes: unique, client_scopes: clientScopes },
        })
        oauthError(res, 400, 'invalid_scope', `Requested scope(s) exceed client grants: ${unknown.join(' ')}`)
        return
      }

      grantedScopes = unique
    }
  } else {
    grantedScopes = clientScopes
  }

  let jwtSecret: string
  try {
    jwtSecret = getOAuthJwtSecret()
  } catch (err) {
    auditLog({
      actor_user_id: canonicalClientId,
      action: 'oauth.token_denied',
      target_type: 'oauth_client',
      target_id: canonicalClientId,
      metadata: { reason: 'insecure_jwt_secret', error: (err as Error).message },
    })
    oauthError(res, 500, 'server_error', 'OAuth token service is unavailable due to insecure secret configuration')
    return
  }

  const now = Math.floor(Date.now() / 1000)
  const ttlSeconds = resolveTokenTtlSeconds()
  const networkId = getNetworkId()
  const payload = {
    sub: canonicalClientId,
    client_id: canonicalClientId,
    scope: grantedScopes.join(' '),
    jti: randomUUID(),
    ...(result.context.orgId && { org_id: result.context.orgId }),
    ...(result.context.userId && { user_id: result.context.userId }),
    iss: 'disciplr',
    aud: 'disciplr-api',
    iat: now,
    exp: now + ttlSeconds,
    ...(networkId && { net: networkId }),
  }

  const accessToken = jwt.sign(payload, jwtSecret)

  auditLog({
    actor_user_id: result.context.userId ?? canonicalClientId,
    action: 'oauth.token_issued',
    target_type: 'oauth_client',
    target_id: canonicalClientId,
    metadata: {
      grant_type: 'client_credentials',
      scopes: grantedScopes,
      expires_in: ttlSeconds,
      ...(result.context.orgId && { org_id: result.context.orgId }),
      ...(networkId && { net: networkId }),
    },
  })

  res
    .status(200)
    .set('Cache-Control', 'no-store')
    .set('Pragma', 'no-cache')
    .json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttlSeconds,
      scope: grantedScopes.join(' '),
    })
})
