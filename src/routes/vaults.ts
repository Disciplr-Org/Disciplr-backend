import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireScopes } from '../middleware/apiKeyAuth.js'
import { ApiScope } from '../types/auth.js'
import { UserRole } from '../types/user.js'
import { VaultService } from '../services/vault.service.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { updateAnalyticsSummary } from '../db/database.js'
import { createAuditLog } from '../lib/audit-logs.js'
import {
  getIdempotentResponse,
  hashRequestPayload,
  saveIdempotentResponse,
  IdempotencyConflictError,
} from '../services/idempotency.js'
import { buildVaultCreationPayload } from '../services/soroban.js'
import { createVaultWithMilestones, getVaultById, listVaults, cancelVaultById, updateVaultById, getVaultRevisionById } from '../services/vaultStore.js'
import { createVaultSchema, flattenZodErrors, isValidStellarAddress } from '../services/vaultValidation.js'
import { AppError } from '../middleware/errorHandler.js'
import { queryParser } from '../middleware/queryParser.js'
import { utcNow } from '../utils/timestamps.js'
import { etagMatches } from '../utils/etag.js'
import type { VaultCreateResponse } from '../types/vaults.js'

export const vaultsRouter = Router()

// In-memory fallback (for development / legacy support)
export let vaults: any[] = []
export const setVaults = (newVaults: any[]) => { vaults = newVaults }

export interface Vault {
  id: string
  creator: string
  amount: string
  status: 'draft' | 'active' | 'completed' | 'failed' | 'cancelled'
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  verifier?: string
  createdAt: string
}

// GET /api/vaults
vaultsRouter.get(
  '/',
  authenticate,
  requireScopes(ApiScope.ReadVaults),
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    try {
      let result = await listVaults()

      if (req.filters && applyFilters) result = applyFilters(result as any, req.filters)
      if (req.sort && applySort) result = applySort(result as any, req.sort)
      if (req.pagination && paginateArray) result = paginateArray(result as any, req.pagination) as any

      res.json(result)
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  },
)

// POST /api/vaults 

vaultsRouter.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  // 1. Idempotency – replay cached response if key+hash match
  const idempotencyKey = req.header('idempotency-key') ?? null
  const requestHash = hashRequestPayload(req.body)

  if (idempotencyKey) {
    try {
      const cached = await getIdempotentResponse<VaultCreateResponse>(idempotencyKey, requestHash)
      if (cached !== null) {
        res.status(200).json({ ...cached, idempotency: { key: idempotencyKey, replayed: true } })
        return
      }
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({ error: err.message })
        return
      }
      throw err
    }
  }

  const parseResult = createVaultSchema.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json({ details: flattenZodErrors(parseResult.error) })
    return
  }

  const input = parseResult.data

  // Ensure Stellar addresses (verifier and destinations) pass checksum
  try {
    if (input.verifier && !(await isValidStellarAddress(input.verifier))) {
      return next(AppError.validation('invalid Stellar public key', { field: 'verifier' }))
    }

    if (input.destinations?.success && !(await isValidStellarAddress(input.destinations.success))) {
      return next(AppError.validation('invalid Stellar public key', { field: 'destinations.success' }))
    }

    if (input.destinations?.failure && !(await isValidStellarAddress(input.destinations.failure))) {
      return next(AppError.validation('invalid Stellar public key', { field: 'destinations.failure' }))
    }
  } catch (err) {
    return next(AppError.internal('address validation failed'))
  }

  try {
    const { vault } = await createVaultWithMilestones(input)
    const responseBody: VaultCreateResponse = {
      vault,
      onChain: await buildVaultCreationPayload(input, vault),
      idempotency: { key: idempotencyKey, replayed: false },
    }

    if (idempotencyKey) {
      await saveIdempotentResponse(idempotencyKey, requestHash, vault.id, responseBody)
    }

    const actorUserId = (req.header('x-user-id') ?? input.creator) || req.user?.userId || 'unknown'
    createAuditLog({
      actor_user_id: actorUserId,
      action: 'vault.created',
      target_type: 'vault',
      target_id: vault.id,
      metadata: { creator: input.creator, amount: input.amount },
    })

    updateAnalyticsSummary()
    res.status(201).json(responseBody)
  } catch (error) {
    console.error('Vault creation failed', error)
    res.status(500).json({ error: 'Failed to create vault.' })
  }
})

// ─── GET /api/vaults/:id ─────────────────────────────────────────────────────

// GET /api/vaults/:id
// Supports ETag-based HTTP caching via If-None-Match header
// Returns 304 Not Modified if client holds current version
vaultsRouter.get('/:id', authenticate, requireScopes(ApiScope.ReadVaults), async (req: Request, res: Response) => {
  try {
    // Try DB-backed store first (falls back to in-memory automatically)
    let vault = await getVaultById(req.params.id)
    
    if (!vault) {
      // Legacy in-memory fallback
      vault = vaults.find((v) => v.id === req.params.id)
      if (!vault) {
        res.status(404).json({ error: 'Vault not found' })
        return
      }
    }

    // Compute ETag from vault revision (optimistic-concurrency version)
    const etag = await getVaultETag(req.params.id)
    if (etag) {
      res.set('ETag', etag)
      res.set('Cache-Control', 'private, max-age=0, must-revalidate')

      // Check If-None-Match header for conditional GET support
      // RFC 7232 Section 3.2: If any of the validators match, send 304
      const ifNoneMatch = req.headers['if-none-match'] as string | undefined
      if (etagMatches(ifNoneMatch, etag)) {
        res.status(304).end()
        return
      }
    }

    res.json(vault)
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch vault' })
  }
})

// PATCH /api/vaults/:id — optimistic-lock update; requires X-Vault-Revision header
vaultsRouter.patch('/:id', authenticate, async (req: Request, res: Response) => {
  const revision = req.header('x-vault-revision') ?? ''
  if (!revision) {
    res.status(400).json({ error: 'X-Vault-Revision header is required' })
    return
  }

  try {
    const updated = await updateVaultById(req.params.id, revision, req.body)
    res.json(updated)
  } catch (err: any) {
    if (err?.status === 409) {
      res.status(409).json({ error: err.message ?? 'Vault update conflict' })
      return
    }
    if (err?.status === 400) {
      res.status(400).json({ error: err.message })
      return
    }
    res.status(500).json({ error: 'Failed to update vault' })
  }
})

// POST /api/vaults/:id/cancel
vaultsRouter.post('/:id/cancel', authenticate, async (req, res) => {
  const actorUserId = req.user!.userId
  const actorRole = req.user!.role

  let existingVault = await VaultService.getVaultById(req.params.id)
  if (!existingVault) existingVault = vaults.find((v) => v.id === req.params.id)

  if (!existingVault) return res.status(404).json({ error: 'Vault not found' })

  if (actorUserId !== existingVault.creator && actorRole !== UserRole.ADMIN) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    await VaultService.updateVaultStatus(req.params.id, 'cancelled' as any)
  } catch (_err) { /* non-fatal */ }

  const arrayIndex = vaults.findIndex((v) => v.id === req.params.id)
  if (arrayIndex !== -1) vaults[arrayIndex].status = 'cancelled'

  updateAnalyticsSummary()
  res.status(200).json({ message: 'Vault cancelled', id: req.params.id })
})

// GET /api/vaults/user/:address 
vaultsRouter.get('/user/:address', authenticate, requireScopes(ApiScope.ReadVaults), async (req: Request, res: Response) => {
  try {
    const userVaults = await VaultService.getVaultsByUser(req.params.address)
    res.json(userVaults)
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch user vaults' })
  }
})
