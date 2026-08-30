import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.js'
import { requireStepUp } from '../middleware/stepUp.js'
import { requireJson } from '../middleware/requireJson.js'
import { apiKeyRateLimiter } from '../middleware/rateLimiter.js'
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
import db from '../db/index.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(authenticate)

const apiKeysJson = requireJson({ maxBytes: 16 * 1024 })

const createApiKeySchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'label is required.')
    .max(120, 'label must be at most 120 characters.'),
  scopes: z
    .array(z.nativeEnum(ApiScope), { error: 'scopes must be an array of strings.' })
    .min(1, 'at least one scope is required.')
    .max(30, 'too many scopes.'),
  orgId: z.string().uuid('orgId must be a valid UUID.').optional(),
}).refine((data) => new Set(data.scopes).size === data.scopes.length, {
  message: 'scopes must not contain duplicates.',
  path: ['scopes'],
})

const apiKeyIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID.'),
})

const orgIdParamSchema = z.object({
  orgId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'orgId must be a valid organization identifier.'),
})

/** Load the user's membership row for an org, or null when absent. */
const getOrgMembership = (orgId: string, userId: string): Promise<{ role: string } | null> =>
  db('org_members')
    .where({ org_id: orgId, user_id: userId })
    .first() as Promise<{ role: string } | null>

/** Resolve an org or null when it does not exist. */
const getOrgById = (orgId: string): Promise<{ id: string } | null> =>
  db('organizations').where({ id: orgId }).first() as Promise<{ id: string } | null>

apiKeysRouter.get('/', async (req, res) => {
  const userId = req.user!.userId
  const apiKeys = (await listApiKeysForUser(userId)).map(({ keyHash: _keyHash, ...publicRecord }) => publicRecord)

  res.json({ apiKeys })
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
      const org = await getOrgById(orgId)
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

  const { keyHash: _keyHash, ...publicRecord } = record
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

  const rotated = await rotateApiKey({
    apiKeyId: paramsResult.data.id,
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

apiKeysRouter.post('/:id/revoke', apiKeysJson, apiKeyRateLimiter, requireStepUp(), async (req, res, next) => {
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

  const { keyHash: _keyHash, ...publicRecord } = record
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
    const org = await getOrgById(orgId)
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