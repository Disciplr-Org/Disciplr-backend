import { Router } from 'express'
import { requireUserAuth } from '../middleware/userAuth.js'
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../services/apiKeys.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(requireUserAuth)

apiKeysRouter.get('/', (req, res) => {
  const userId = req.authUser!.userId
  const apiKeys = listApiKeysForUser(userId).map(({ keyHash: _keyHash, ...publicRecord }) => publicRecord)

  res.json({ apiKeys })
})

apiKeysRouter.post('/', (req, res) => {
  const userId = req.authUser!.userId
  const { label, scopes, orgId } = req.body as {
    label?: string
    scopes?: unknown
    orgId?: string
  }

  if (!label?.trim()) {
    res.status(400).json({ error: 'label is required.' })
    return
  }

  if (!Array.isArray(scopes)) {
    res.status(400).json({ error: 'scopes must be an array of scope strings.' })
    return
  }

  const normalizedScopes = scopes
    .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
    .filter(Boolean)

  const { apiKey, record } = createApiKey({
    userId,
    orgId: orgId?.trim() || undefined,
    label: label.trim(),
    scopes: normalizedScopes,
  })

  const { keyHash: _keyHash, ...publicRecord } = record
  res.status(201).json({
    apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/revoke', (req, res) => {
  const userId = req.authUser!.userId
  const record = revokeApiKey(req.params.id, userId)

  if (!record) {
    res.status(404).json({ error: 'API key not found.' })
    return
  }

  const { keyHash: _keyHash, ...publicRecord } = record
  res.json({ apiKeyMeta: publicRecord })
})
