import type { RequestHandler } from 'express'
import { validateApiKey } from '../services/apiKeys.js'
import type { ApiScope } from '../types/auth.js'

export const authenticateApiKey = (requiredScopes: ApiScope[] = []): RequestHandler => {
  return async (req, res, next) => {
    const apiKey = req.header('x-api-key')

    if (!apiKey) {
      res.status(401).json({ error: 'Missing API key. Provide x-api-key header.' })
      return
    }

    // Use only req.ip, which Express resolves from the trusted proxy chain
    // (controlled by the TRUST_PROXY setting in app.ts).  Never fall back to
    // reading x-forwarded-for directly — a direct client can forge that header
    // and corrupt IP-based auditing / abuse-detection keyed on clientIp.
    const clientIp = req.ip ?? 'unknown'
    const validation = await validateApiKey(apiKey, requiredScopes, clientIp)
    if (!validation.valid) {
      if (validation.reason === 'forbidden') {
        res.status(403).json({ error: 'API key does not have the required scopes.' })
        return
      }

      if (validation.reason === 'expired') {
        res.status(401).json({ error: 'API key is expired.' })
        return
      }

      const reasonLabel = validation.reason === 'revoked' ? 'revoked' : 'invalid'
      res.status(401).json({ error: `API key is ${reasonLabel}.` })
      return
    }

    // Signal to clients that they are still using the previous secret during
    // the rotation grace window.
    if (validation.usingPreviousSecret) {
      res.setHeader('Deprecation', 'true')
      res.setHeader(
        'Warning',
        '299 - "API key rotated; this secret is in its grace window and will soon be invalid. Update to the new secret."',
      )
    }

    req.apiKeyAuth = validation.context
    next()
  }
}

// Require at least one of the provided scopes when an API key is used.
export const requireScopes = (...requiredScopes: ApiScope[]): RequestHandler => {
  return (req, res, next) => {
    const context = req.apiKeyAuth
    if (!context) {
      // No API key in use; allow other auth mechanisms (JWT) to control access
      next()
      return
    }

    const hasOne = requiredScopes.some((scope) => context.scopes.includes(scope))
    if (!hasOne) {
      res.status(403).json({ error: 'API key does not have the required scopes.' })
      return
    }

    next()
  }
}
