import { Router } from 'express'
import { z } from 'zod'
import { requireUserAuth } from '../middleware/userAuth.js'
import { apiKeyRateLimiter } from '../middleware/rateLimiter.js'
import {
  createApiKey,
  listApiKeysForUser,
  revokeApiKey,
  rotateApiKey,
} from '../services/apiKeys.js'
import { formatValidationError } from '../lib/validation.js'
import { createAuditLog } from '../lib/audit-logs.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(requireUserAuth)

const createApiKeySchema = z.object({
  label: z.string().trim().min(1, 'label is required.'),
  scopes: z.array(z.string().trim().min(1, 'scope must be a non-empty string.')),
  orgId: z.string().trim().optional(),
})

apiKeysRouter.get('/', async (req, res) => {
  const userId = req.authUser!.userId
  const apiKeys = (await listApiKeysForUser(userId)).map(({ keyHash: _keyHash, ...publicRecord }) => publicRecord)

  res.json({ apiKeys })
})

apiKeysRouter.post('/', apiKeyRateLimiter, async (req, res) => {
  const userId = req.authUser!.userId
  const parseResult = createApiKeySchema.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json(formatValidationError(parseResult.error))
    return
  }

  const { label, scopes, orgId } = parseResult.data

  const { apiKey, record } = await createApiKey({
    userId,
    orgId: orgId?.trim() || undefined,
    label,
    scopes,
  })

  const { keyHash: _keyHash, ...publicRecord } = record
  res.status(201).json({
    apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/rotate', apiKeyRateLimiter, async (req, res) => {
  const userId = req.authUser!.userId
  const rotated = await rotateApiKey({
    apiKeyId: req.params.id,
    userId,
  })

  if (!rotated) {
    res.status(404).json({ error: 'API key not found.' })
    return
  }

  createAuditLog({
    actor_user_id: userId,
    action: 'api_key.rotated',
    target_type: 'api_key',
    target_id: rotated.record.id,
    metadata: { label: rotated.record.label, scopes: rotated.record.scopes },
  })

  const { keyHash: _keyHash, ...publicRecord } = rotated.record
  res.status(200).json({
    apiKey: rotated.apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/revoke', async (req, res) => {
  const userId = req.authUser!.userId
  const record = await revokeApiKey(req.params.id, userId)

  if (!record) {
    res.status(404).json({ error: 'API key not found.' })
    return
  }

  createAuditLog({
    actor_user_id: userId,
    action: 'api_key.revoked',
    target_type: 'api_key',
    target_id: record.id,
    metadata: { label: record.label, scopes: record.scopes },
  })

  const { keyHash: _keyHash, ...publicRecord } = record
  res.json({ apiKeyMeta: publicRecord })
})
