import { Router, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { validateApiKey } from '../services/apiKeys.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { getJwtSecret } from '../lib/auth-utils.js'
import { authRateLimiter } from '../middleware/rateLimiter.js'
import { getEnv } from '../config/index.js'
import type { ApiScope } from '../types/auth.js'
import { requestTelemetry } from '../middleware/telemetry.js'
import { requireJson } from '../middleware/requireJson.js'

export const oauthRouter = Router()
oauthRouter.use(requestTelemetry);

const TOKEN_TTL_SECONDS = Number(process.env.OAUTH_TOKEN_TTL_SECONDS ?? 3600)
const MAX_SCOPES_PER_REQUEST = 20
const MAX_SCOPE_LENGTH = 64

const oauthJson = requireJson({ maxBytes: 16384 })

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
  const { grant_type, client_id, client_secret, scope } = req.body ?? {}

  if (grant_type !== 'client_credentials') {
    oauthError(res, 400, 'unsupported_grant_type', 'Only client_credentials is supported')
    return
  }

  if (!client_id || !client_secret) {
    oauthError(res, 400, 'invalid_request', 'client_id and client_secret are required')
    return
  }

  const result = await validateApiKey(client_secret as string)

  if (!result.valid) {
    auditLog({
      actor_user_id: String(client_id),
      action: 'oauth.token_denied',
      target_type: 'oauth_client',
      target_id: String(client_id),
      metadata: { reason: result.reason, grant_type: 'client_credentials' },
    })
    oauthError(res, 401, 'invalid_client', 'Invalid client credentials')
    return
  }

  const canonicalClientId = result.context.apiKeyId

  if (String(client_id) !== canonicalClientId) {
    auditLog({
      actor_user_id: canonicalClientId,
      action: 'oauth.token_denied',
      target_type: 'oauth_client',
      target_id: canonicalClientId,
      metadata: { reason: 'client_id_mismatch', grant_type: 'client_credentials', presented_client_id: String(client_id) },
    })
    oauthError(res, 401, 'invalid_client', 'Invalid client credentials')
    return
  }

  const clientScopes: ApiScope[] = result.context.scopes
  let grantedScopes: ApiScope[]

  if (scope) {
    if (typeof scope !== 'string' || scope.length > MAX_SCOPES_PER_REQUEST * MAX_SCOPE_LENGTH) {
      oauthError(res, 400, 'invalid_scope', 'Requested scope is too long')
      return
    }

    const requested = String(scope)
      .split(' ')
      .map((s) => s.trim())
      .filter(Boolean) as ApiScope[]

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

    const unknown = requested.filter((s) => !clientScopes.includes(s))
    if (unknown.length > 0) {
      auditLog({
        actor_user_id: canonicalClientId,
        action: 'oauth.token_denied',
        target_type: 'oauth_client',
        target_id: canonicalClientId,
        metadata: { reason: 'scope_exceeded', requested_scopes: requested, client_scopes: clientScopes },
      })
      oauthError(res, 400, 'invalid_scope', `Requested scope(s) exceed client grants: ${unknown.join(' ')}`)
      return
    }

    grantedScopes = requested
  } else {
    grantedScopes = clientScopes
  }

  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: canonicalClientId,
    client_id: canonicalClientId,
    scope: grantedScopes.join(' '),
    ...(result.context.orgId && { org_id: result.context.orgId }),
    ...(result.context.userId && { user_id: result.context.userId }),
    iss: 'disciplr',
    aud: 'disciplr-api',
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  }

  const accessToken = jwt.sign(payload, getEnv().JWT_SECRET)

  auditLog({
    actor_user_id: result.context.userId ?? canonicalClientId,
    action: 'oauth.token_issued',
    target_type: 'oauth_client',
    target_id: canonicalClientId,
    metadata: {
      grant_type: 'client_credentials',
      scopes: grantedScopes,
      expires_in: TOKEN_TTL_SECONDS,
      ...(result.context.orgId && { org_id: result.context.orgId }),
    },
  })

  res
    .status(200)
    .set('Cache-Control', 'no-store')
    .set('Pragma', 'no-cache')
    .json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: grantedScopes.join(' '),
    })
})
