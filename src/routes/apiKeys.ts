import { Router } from 'express'
import express from 'express'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.js'
import { requireStepUp } from '../middleware/stepUp.js'
import { apiKeyRateLimiter } from '../middleware/rateLimiter.js'
import { requestTelemetry } from '../middleware/telemetry.js'
import {
  createApiKey,
  listApiKeysForUser,
  listApiKeysForOrg,
  revokeApiKey,
  rotateApiKey,
} from '../services/apiKeys.js'
import { formatValidationError } from '../lib/validation.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { ApiScope } from '../types/auth.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(authenticate)
apiKeysRouter.use(requestTelemetry)
apiKeysRouter.use(express.json({ limit: 16384 }))

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const MAX_LABEL_LENGTH = 100
const MAX_SCOPES_COUNT = 20
const MAX_SCOPE_LENGTH = 64

const createApiKeySchema = z.object({
  label: z.string().trim().min(1, 'label is required.').max(MAX_LABEL_LENGTH, `label must be at most ${MAX_LABEL_LENGTH} characters.`),
  scopes: z.array(z.string().trim().min(1, 'scope must be a non-empty string.').max(MAX_SCOPE_LENGTH, `scope must be at most ${MAX_SCOPE_LENGTH} characters.`)).max(MAX_SCOPES_COUNT, `scopes must have at most ${MAX_SCOPES_COUNT} items.`),
  orgId: z.string().trim().optional(),
})

const parsePagination = (query: Record<string, unknown>): { limit: number; offset: number } => {
  const rawLimit = typeof query.limit === 'string' ? query.limit : undefined
  const rawOffset = typeof query.offset === 'string' ? query.offset : undefined
  const limit = rawLimit ? Math.min(Math.max(parseInt(rawLimit, 10) || 0, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT
  const offset = rawOffset ? Math.max(parseInt(rawOffset, 10) || 0, 0) : 0
  return { limit, offset }
}

apiKeysRouter.get('/', async (req, res) => {
  const userId = req.user!.userId
  const { limit, offset } = parsePagination(req.query)
  // NOTE: The service currently returns all keys. We bound the response size here.
  const allKeys = await listApiKeysForUser(userId)
  const page = allKeys.slice(offset, offset + limit).map(({ keyHash: _keyHash, ...publicRecord }) => publicRecord)
  res.json({
    apiKeys: page,
    pagination: { limit, offset, total: allKeys.length },
  })
})

apiKeysRouter.post('/', apiKeyRateLimiter, async (req, res) => {
  const userId = req.user!.userId
  const parseResult = createApiKeySchema.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json(formatValidationError(parseResult.error))
    return
  }

  const { label, scopes, orgId } = parseResult.data

  // Validate scope names against the typed ApiScope enum
  const validScopeValues = new Set(Object.values(ApiScope) as string[])
  const invalidIndex = scopes.findIndex((s: string) => !validScopeValues.has(s))
  if (invalidIndex !== -1) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        fields: [{ path: `scopes[${invalidIndex}]`, message: 'Invalid scope', code: 'invalid_value' }],
      },
    })
    return
  }

  const { apiKey, record } = await createApiKey({
    userId,
    orgId: orgId?.trim() || undefined,
    label,
    scopes: scopes as ApiScope[],
  })

  const { keyHash: _keyHash, ...publicRecord } = record
  res.status(201).json({
    apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/rotate', apiKeyRateLimiter, async (req, res) => {
  const userId = req.user!.userId
  const rotated = await rotateApiKey({
    apiKeyId: req.params.id,
    userId,
  })

  if (!rotated) {
    res.status(404).json({ error: 'API key not found.' })
    return
  }

  await createAuditLog({
    actor_user_id: userId,
    action: 'api_key.rotated',
    target_type: 'api_key',
    target_id: rotated.record.id,
    metadata: { label: rotated.record.label, scopes: rotated.record.scopes },
  }).catch((err) => console.error('Failed to write audit log:', err))

  const { keyHash: _keyHash, ...publicRecord } = rotated.record
  res.status(200).json({
    apiKey: rotated.apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/revoke', apiKeyRateLimiter, requireStepUp(), async (req, res) => {
  const userId = req.user!.userId
  const record = await revokeApiKey(req.params.id, userId)

  if (!record) {
    res.status(404).json({ error: 'API key not found.' })
    return
  }

  await createAuditLog({
    actor_user_id: userId,
    action: 'api_key.revoked',
    target_type: 'api_key',
    target_id: record.id,
    metadata: { label: record.label, scopes: record.scopes },
  }).catch((err) => console.error('Failed to write audit log:', err))

  const { keyHash: _keyHash, ...publicRecord } = record
  res.json({ apiKeyMeta: publicRecord })
})

export const getApiKeyUsageHandler = async (req: any, res: any) => {
  const { orgId } = req.params
  const keys = await listApiKeysForOrg(orgId)

  const usage = keys.map(({ keyHash: _keyHash, ...publicRecord }) => ({
    id: publicRecord.id,
    label: publicRecord.label,
    scopes: publicRecord.scopes,
    createdAt: publicRecord.createdAt,
    revokedAt: publicRecord.revokedAt,
    lastUsedAt: publicRecord.lastUsedAt ?? null,
    requestCount: publicRecord.requestCount ?? 0,
    lastIp: publicRecord.lastIp ?? null,
  }))

  res.json({ usage })
}
