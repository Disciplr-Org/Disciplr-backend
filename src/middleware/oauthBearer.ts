import type { Request, Response, NextFunction, RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { getEnv } from '../config/index.js'
import type { ApiScope } from '../types/auth.js'

export interface OAuthTokenPayload {
  sub: string
  client_id: string
  scope: string
  org_id?: string
  user_id?: string
  iss: string
  aud: string
  iat: number
  exp: number
  jti?: string
  net?: string
}

/**
 * Resolve the Stellar network this deployment is bound to. Tokens carrying a
 * `net` claim are only accepted when it matches, preventing cross-network
 * (e.g. testnet→mainnet) token replay. `null` when undeclared.
 */
const getNetworkId = (): string | null => {
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

declare global {
  namespace Express {
    interface Request {
      oauthToken?: OAuthTokenPayload
    }
  }
}

/**
 * Validate an OAuth2 bearer token issued by POST /api/oauth/token.
 * Attaches the decoded payload to req.oauthToken on success.
 *
 * @param requiredScopes  When provided, the token must carry ALL of them.
 */
export const authenticateOAuthBearer = (requiredScopes: ApiScope[] = []): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized: Bearer token required' })
      return
    }

    const token = authHeader.slice(7)

    let payload: OAuthTokenPayload
    try {
      payload = jwt.verify(token, getEnv().JWT_SECRET, {
        issuer: 'disciplr',
        audience: 'disciplr-api',
      }) as OAuthTokenPayload
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        res.status(401).json({ error: 'Unauthorized: Token expired' })
      } else {
        res.status(401).json({ error: 'Unauthorized: Invalid token' })
      }
      return
    }

    if (requiredScopes.length > 0) {
      const tokenScopes = payload.scope ? payload.scope.split(' ') : []
      const missing = requiredScopes.filter((s) => !tokenScopes.includes(s))
      if (missing.length > 0) {
        res.status(403).json({ error: `Forbidden: missing scope(s): ${missing.join(' ')}` })
        return
      }
    }

    // Cross-network replay guard: when the token declares the network it was
    // minted for (`net` claim), it must match the network this deployment is
    // bound to. Tokens without the claim are accepted for backward
    // compatibility with previously-issued tokens.
    if (payload.net !== undefined && payload.net !== getNetworkId()) {
      res.status(401).json({ error: 'Unauthorized: Token bound to a different network' })
      return
    }

    req.oauthToken = payload
    next()
  }
}
