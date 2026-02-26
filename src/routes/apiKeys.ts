import { Router } from 'express'
import { requireUserAuth } from '../middleware/userAuth.js'
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../services/apiKeys.js'
import { createValidationMiddleware } from '../middleware/validation/index.js'
import { createApiKeySchema, revokeApiKeySchema } from '../middleware/validation/schemas.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(requireUserAuth)

apiKeysRouter.get('/', (req, res) => {
  const userId = req.authUser!.userId
  const apiKeys = listApiKeysForUser(userId).map(({ keyHash: _keyHash, ...publicRecord }) => publicRecord)

  res.json({ apiKeys })
})

apiKeysRouter.post('/', 
  createValidationMiddleware(createApiKeySchema, { source: 'body' }),
  (req, res) => {
    const userId = req.authUser!.userId
    const { label, scopes, orgId } = req.body

    const { apiKey, record } = createApiKey({
      userId,
      orgId,
      label,
      scopes,
    })

    const { keyHash: _keyHash, ...publicRecord } = record
    res.status(201).json({
      apiKey,
      apiKeyMeta: publicRecord,
    })
  }
)

apiKeysRouter.post('/:id/revoke',
  createValidationMiddleware(revokeApiKeySchema, { source: 'params' }),
  (req, res) => {
    const userId = req.authUser!.userId
    const record = revokeApiKey(req.params.id, userId)

    if (!record) {
      res.status(404).json({ error: 'API key not found.' })
      return
    }

    const { keyHash: _keyHash, ...publicRecord } = record
    res.json({ apiKeyMeta: publicRecord })
  }
)
