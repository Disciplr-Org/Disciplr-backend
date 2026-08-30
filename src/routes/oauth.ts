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

export const oauthRouter = Router()
const oauthJson = requireJson({ maxBytes: 4 * 1024 })

const DEFAULT_TOKEN_TTL_SECONDS = 3600
const MIN_TOKEN_TTL_SECONDS = 60
const MAX_TOKEN_TTL_SECONDS = 12 * 60 * 60 // 12-hour ceiling on access tokens

/**
 * Resolve the OAuth access-token lifetime from configuration.
 *
 * Falls back to 1 hour when the value is missing, unparsable, or outside the
 * enforceable [60s, 12h] window so a hostile/misconfigured deployment can never
 * mint unbounded-lifetime tokens.
 */
export const resolveTokenTtlSeconds = (): number => {
  const raw = process.env.OAUTH_TOKEN_TTL_SECONDS
  if (!raw) {
    return DEFAULT_TOKEN_TTL_SECONDS
  }

  const parsed = Number(raw)
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_TOKEN_TTL_SECONDS ||
    parsed > MAX_TOKEN_TTL_SECONDS
  ) {
    return DEFAULT_TOKEN_TTL_SECONDS
  }

  return parsed
}

const TOKEN_TTL_SECONDS = resolveTokenTtlSeconds()

/**
 * Resolve the Stellar network this deployment is bound to. OAuth tokens carry
 * a `net` claim so a token minted against one network cannot be replayed
 * against another (testnet→mainnet submission). `null` when undeclared.
 */
export const getNetworkId = (): string | null => {
  try {
    return (
      getEnv().STELLAR_NETWORK_PASSPHRASE ??
      getEnv().SOROBAN_NETWORK_PASSPHRASE ??
      null
    )
  } catch {
    return (
      process.env.STELLAR_NETWORK_PASSPHRASE ??
      process.env.SOROBAN_NETWORK_PASSPHRASE ??
      null
    )
  }
}

const NETWORK_ID = getNetworkId()

/** RFC 6749 §2.3.1 / §4.4.1 token-request payload boundary. */
export const oauthTokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().uuid('client_id must be a valid UUID.'),
  client_secret: z
    .string()
    .min(1, 'client_secret is required.')
    .max(1024, 'client_secret exceeds the maximum permitted length.'),
  scope: z
    .string()
    .trim()
    .max(256, 'scope exceeds the maximum permitted length.')
    .optional(),
})

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
  const body: unknown = req.body
  const rawBody = (body ?? {}) as Record<string, unknown>

  // RFC 6749 §5.2 — an unsupported/missing grant_type is reported distinctly.
  if (rawBody.grant_type !== 'client_credentials') {
    oauthError(res, 400, 'unsupported_grant_type', 'Only client_credentials is supported')
    return
  }

  const parsed = oauthTokenRequestSchema.safeParse(body)
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
  let grantedScopes: ApiScope[]

  if (scope !== undefined) {
    const requested = String(scope)
      .split(' ')
      .map((s) => s.trim())
      .filter(Boolean) as ApiScope[]

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

  const now = Math.floor(Date.now() / 1000)
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
    exp: now + TOKEN_TTL_SECONDS,
    ...(NETWORK_ID && { net: NETWORK_ID }),
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
      ...(NETWORK_ID && { net: NETWORK_ID }),
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