import type { Request, Response, NextFunction, RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import type { ApiScope } from '../types/auth.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

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
      payload = jwt.verify(token, JWT_SECRET, {
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

    req.oauthToken = payload
    next()
  }
}
