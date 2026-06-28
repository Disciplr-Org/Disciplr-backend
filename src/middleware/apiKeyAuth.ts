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

    const validation = await validateApiKey(apiKey, requiredScopes)
    if (!validation.valid) {
      if (validation.reason === 'forbidden') {
        res.status(403).json({ error: 'API key does not have the required scopes.' })
        return
      }

      const reasonLabel = validation.reason === 'revoked' ? 'revoked' : 'invalid'
      res.status(401).json({ error: `API key is ${reasonLabel}.` })
      return
    }

    req.apiKeyAuth = validation.context
    next()
  }
}

// Require at least one of the provided scopes when an API key is used.
export const requireScopes = (...required: ApiScope[]): RequestHandler => {
  return (req, res, next) => {
    const context = req.apiKeyAuth
    if (!context) {
      // No API key in use; allow other auth mechanisms (JWT) to control access
      next()
      return
    }

    const hasOne = required.some((scope) => context.scopes.includes(scope))
    if (!hasOne) {
      res.status(403).json({ error: 'API key does not have the required scopes.' })
      return
    }

    next()
  }
}
