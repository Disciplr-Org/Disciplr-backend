import type { RequestHandler } from 'express'
import { validateApiKey } from '../services/apiKeys.js'

export const authenticateApiKey = (requiredScopes: string[] = []): RequestHandler => {
  return (req, res, next) => {
    const apiKey = req.header('x-api-key')

    if (!apiKey) {
      res.status(401).json({ error: 'Missing API key. Provide x-api-key header.' })
      return
    }

    const validation = validateApiKey(apiKey, requiredScopes)
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
