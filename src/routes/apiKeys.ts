import { Router, type NextFunction, type Request, type Response } from 'express'
import express from 'express'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.js'
import { requireStepUp } from '../middleware/stepUp.js'
import { requireJson } from '../middleware/requireJson.js'
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
import { apiKeyIdParamSchema, createApiKeySchema } from '../lib/apiCredentialSchemas.js'
import { getOrganizationById } from '../services/organization.js'
import { getOrgMembership } from '../services/membership.js'
import db from '../db/index.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(authenticate)
apiKeysRouter.use(requestTelemetry)
apiKeysRouter.use(express.json({ limit: 16384 }))

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100

const apiKeysJson = requireJson({ maxBytes: 16 * 1024 })

const orgIdParamSchema = z.object({
  orgId: z.string().trim().uuid('orgId must be a UUID.'),
})

const rotateApiKeyBodySchema = z.object({
  graceSeconds: z.number().int().min(0).max(3600).optional(),
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
  const page = allKeys.slice(offset, offset + limit).map(({ keyHash: _keyHash, previousKeyHash: _prevHash, ...publicRecord }) => publicRecord)
  res.json({
    apiKeys: page,
    pagination: { limit, offset, total: allKeys.length },
  })
})

apiKeysRouter.post('/', apiKeysJson, apiKeyRateLimiter, async (req, res, next) => {
  const userId = req.user!.userId
  const parseResult = createApiKeySchema.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json(formatValidationError(parseResult.error))
    return
  }

  const { label, scopes, orgId } = parseResult.data

  // Server-side ownership verification: never trust a client-supplied orgId.
  // The key may only be bound to an org the caller actually belongs to.
  if (orgId) {
    try {
      const org = await getOrganizationById(orgId)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found.' } })
        return
      }
      const membership = await getOrgMembership(orgId, userId)
      if (!membership) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Forbidden: not a member of this organization.' },
        })
        return
      }
    } catch (err) {
      next(err)
      return
    }
  }

  const { apiKey, record } = await createApiKey({
    userId,
    orgId,
    label,
    scopes,
  })

  const { keyHash: _keyHash, previousKeyHash: _prevHash, ...publicRecord } = record
  res.status(201).json({
    apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/rotate', apiKeysJson, apiKeyRateLimiter, async (req, res, next) => {
  const userId = req.user!.userId
  const paramsResult = apiKeyIdParamSchema.safeParse(req.params)
  if (!paramsResult.success) {
    res.status(400).json(formatValidationError(paramsResult.error))
    return
  }

  const bodyResult = rotateApiKeyBodySchema.safeParse(req.body ?? {})
  if (!bodyResult.success) {
    res.status(400).json(formatValidationError(bodyResult.error))
    return
  }

  const { graceSeconds } = bodyResult.data

  const rotated = await rotateApiKey({
    apiKeyId: paramsResult.data.id,
    userId,
    graceSeconds,
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
    metadata: {
      label: rotated.record.label,
      scopes: rotated.record.scopes,
      graceSeconds: graceSeconds ?? 300,
      previousValidUntil: rotated.record.previousValidUntil,
    },
  }).catch((err) => console.error('Failed to write audit log:', err))

  const { keyHash: _keyHash, previousKeyHash: _prevHash, ...publicRecord } = rotated.record
  res.status(200).json({
    apiKey: rotated.apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/revoke', apiKeyRateLimiter, requireStepUp(), async (req, res) => {
  const userId = req.user!.userId
  const paramsResult = apiKeyIdParamSchema.safeParse(req.params)
  if (!paramsResult.success) {
    res.status(400).json(formatValidationError(paramsResult.error))
    return
  }

  const record = await revokeApiKey(paramsResult.data.id, userId)

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

  const { keyHash: _keyHash, previousKeyHash: _prevHash, ...publicRecord } = record
  res.json({ apiKeyMeta: publicRecord })
})

export const getApiKeyUsageHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const paramsResult = orgIdParamSchema.safeParse(req.params ?? {})
  if (!paramsResult.success) {
    res.status(400).json(formatValidationError(paramsResult.error))
    return
  }

  // Authorization must come from server-side identity, never client state.
  const userId = (req as any).user?.userId ?? (req as any).authUser?.userId
  if (!userId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } })
    return
  }

  const orgId = paramsResult.data.orgId

  try {
    const org = await getOrganizationById(orgId)
    if (!org) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found.' } })
      return
    }
    const membership = await getOrgMembership(orgId, userId)
    if (!membership) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Forbidden: not a member of this organization.' },
      })
      return
    }
  } catch (err) {
    next(err)
    return
  }

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