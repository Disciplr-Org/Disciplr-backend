import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import { requireScopes } from '../middleware/apiKeyAuth.js'
import { ApiScope } from '../types/auth.js'
import { UserRole } from '../types/user.js'
import { VaultService } from '../services/vault.service.js'
import { disputeVault, resolveDispute } from '../services/vaultTransitions.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { updateAnalyticsSummary } from '../services/analytics.service.js'
import { createAuditLog } from '../lib/audit-logs.js'
import {
  hashRequestPayload,
  validateIdempotencyKey,
  scopeIdempotencyKey,
  type OwnerContext,
} from '../services/idempotency.js'
import { buildVaultCreationPayload } from '../services/soroban.js'
import { createVaultWithMilestones, getVaultById, listVaults, cancelVaultById, updateVaultById, getVaultRevisionById, getVaultETag } from '../services/vaultStore.js'
import { createVaultIdempotently, VaultCreationIdempotencyConflictError, VaultCreationInProgressError, VaultCreationOwnerError } from '../services/vaultCreationIdempotency.js'
import { createVaultSchema, flattenZodErrors, isValidStellarAddress, isMemoRequired } from '../services/vaultValidation.js'
import { StrKey } from '@stellar/stellar-sdk'
import { AppError } from '../middleware/errorHandler.js'
import { queryParser } from '../middleware/queryParser.js'
import { utcNow } from '../utils/timestamps.js'
import { etagMatches } from '../utils/etag.js'
import type { VaultCreateResponse } from '../types/vaults.js'

export const vaultsRouter = Router()

// ─── Minimal compatibility exports for test support ───────────────────────────
// These exports maintain backward compatibility for existing test suites that
// rely on the old in-memory vault array pattern. Per maintainer request (option 2).
// Tests should be migrated to use vaultStore helpers directly over time.

export interface Vault {
  id: string
  creator: string
  amount: string
  status: 'draft' | 'active' | 'completed' | 'failed' | 'cancelled' | 'disputed'
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  verifier?: string
  createdAt: string
  endDate?: string  // Alias for endTimestamp (used in some tests)
  lateCheckInWindowSecs?: number
}

// In-memory vault array for test compatibility only
let testVaults: Vault[] = []

/**
 * Sets the in-memory vault array for test purposes.
 * This is a compatibility shim for existing tests.
 * Production code should use vaultStore helpers instead.
 */
export const setVaults = (newVaults: Vault[]): void => {
  testVaults = newVaults
}

/**
 * Gets the in-memory vault array for test purposes.
 * This is a compatibility shim for existing tests.
 */
export const getTestVaults = (): Vault[] => testVaults

// Export the array for direct access in tests (legacy pattern)
export const vaults = testVaults

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

      if (req.filters && applyFilters) result = applyFilters(result as any, req.filters, ['status'])
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
  const rawIdempotencyKey = req.header('idempotency-key') ?? null
  let scopedIdempotencyKey: string | null = null
  const actorUserId = (req.header('x-user-id') ?? req.body?.creator) || req.user?.userId || 'unknown'

  if (rawIdempotencyKey) {
    const validation = validateIdempotencyKey(rawIdempotencyKey)
    if (!validation.valid) {
      res.status(400).json({
        error: {
          code: validation.code,
          message: validation.error,
        },
      })
      return
    }
    scopedIdempotencyKey = scopeIdempotencyKey(actorUserId, rawIdempotencyKey)
  }

  const requestHash = hashRequestPayload(req.body)

  // Derive owner from authenticated principal (JWT or API key)
  const owner: OwnerContext = {
    userId: req.user?.userId ?? req.apiKeyAuth?.userId ?? null,
    orgId: req.apiKeyAuth?.orgId ?? req.user?.enterpriseId ?? null,
  }

  const parseResult = createVaultSchema.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json({ details: flattenZodErrors(parseResult.error) })
    return
  }

  const input = parseResult.data

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

    if (input.destinations?.success && !StrKey.isValidMed25519PublicKey(input.destinations.success)) {
      if (await isMemoRequired(input.destinations.success)) {
        return next(AppError.validation('Destination is a known exchange that requires a memo. Use a muxed address.', { field: 'destinations.success' }))
      }
    }

    if (input.destinations?.failure && !StrKey.isValidMed25519PublicKey(input.destinations.failure)) {
      if (await isMemoRequired(input.destinations.failure)) {
        return next(AppError.validation('Destination is a known exchange that requires a memo. Use a muxed address.', { field: 'destinations.failure' }))
      }
    }
  } catch (err) {
    return next(AppError.internal('address validation failed'))
  }

  try {
    let responseBody: VaultCreateResponse
    let replayed = false
    if (scopedIdempotencyKey) {
      const createResult = await createVaultIdempotently(
        { key: scopedIdempotencyKey, requestHash, owner },
        async client => {
          const { vault } = await createVaultWithMilestones(input, client ?? undefined)
          const response: VaultCreateResponse = {
            vault,
            onChain: await buildVaultCreationPayload(input, vault),
            idempotency: { key: rawIdempotencyKey, replayed: false },
          }
          return { vault, response }
        },
      )
      responseBody = {
        ...createResult.response,
        idempotency: { key: rawIdempotencyKey, replayed: createResult.replayed },
      }
      replayed = createResult.replayed
    } else {
      const { vault } = await createVaultWithMilestones(input)
      responseBody = {
        vault,
        onChain: await buildVaultCreationPayload(input, vault),
        idempotency: { key: rawIdempotencyKey, replayed: false },
      }
    }
    const vault = responseBody.vault

    createAuditLog({
      actor_user_id: actorUserId,
      action: 'vault.created',
      target_type: 'vault',
      target_id: vault.id,
      metadata: { creator: input.creator, amount: input.amount },
    })

    updateAnalyticsSummary()
    res.status(replayed ? 200 : 201).json(responseBody)
  } catch (error) {
    if (error instanceof VaultCreationIdempotencyConflictError || error instanceof VaultCreationOwnerError) {
      res.status(409).json({ error: { code: error.code, message: error.message } })
      return
    }
    if (error instanceof VaultCreationInProgressError) {
      res.status(409).json({ error: { code: error.code, message: error.message, retryable: true } })
      return
    }
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
    // Use DB-backed store
    const vault = await getVaultById(req.params.id)
    
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' })
      return
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

// GET /api/vaults/:id/timeline
vaultsRouter.get('/:id/timeline', authenticate, async (req, res, next) => {
  const { id } = req.params
  const actorUserId = req.user!.userId
  const actorRole = req.user!.role

  try {
    const vault = await getVaultById(id)
    if (!vault) {
      return next(AppError.notFound('Vault not found'))
    }

    // Authorization: only vault creator or an admin can view the timeline
    if (actorUserId !== vault.creator && actorRole !== UserRole.ADMIN) {
      return next(AppError.forbidden('You do not have permission to view this vault timeline.'))
    }

    const timeline = await VaultService.getVaultTimeline(id)
    res.json({ timeline })
  } catch (error) {
    console.error(`Failed to fetch timeline for vault ${id}:`, error)
    return next(AppError.internal('Failed to fetch vault timeline.'))
  }
})

// POST /api/vaults/:id/cancel
vaultsRouter.post('/:id/cancel', authenticate, async (req, res) => {
  const actorUserId = req.user!.userId
  const actorRole = req.user!.role

  const existingVault = await VaultService.getVaultById(req.params.id)
  if (!existingVault) return res.status(404).json({ error: 'Vault not found' })

  if (actorUserId !== existingVault.creator && actorRole !== UserRole.ADMIN) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    await VaultService.updateVaultStatus(req.params.id, 'cancelled')
  } catch (_err) { /* non-fatal */ }

  updateAnalyticsSummary()
  res.status(200).json({ message: 'Vault cancelled', id: req.params.id })
})

// POST /api/vaults/:id/dispute
// Admin-only: places an `active` vault into `disputed`, blocking slash/claim until resolved.
// `requireAdmin` derives the caller's role from the verified JWT (req.user.role), not
// from anything supplied in the request body — see vaultTransitions.ts for details.
vaultsRouter.post('/:id/dispute', authenticate, requireAdmin, (req: Request, res: Response) => {
  const result = disputeVault(req.params.id, req.user!.userId, req.user!.role)

  if (!result.success) {
    const status = result.error === 'Vault not found' ? 404 : 409
    res.status(status).json({ error: result.error })
    return
  }

  updateAnalyticsSummary()
  res.status(200).json({ message: 'Vault placed into disputed state', id: req.params.id })
})

const DISPUTE_RESOLUTION_TARGETS = ['active', 'completed', 'failed'] as const
type DisputeResolutionTarget = (typeof DISPUTE_RESOLUTION_TARGETS)[number]

const isDisputeResolutionTarget = (value: unknown): value is DisputeResolutionTarget =>
  typeof value === 'string' && (DISPUTE_RESOLUTION_TARGETS as readonly string[]).includes(value)

// POST /api/vaults/:id/resolve-dispute
// Admin-only: resolves a `disputed` vault back to `active`, or directly to `completed` / `failed`.
vaultsRouter.post('/:id/resolve-dispute', authenticate, requireAdmin, (req: Request, res: Response) => {
  const { target } = (req.body ?? {}) as { target?: unknown }

  if (!isDisputeResolutionTarget(target)) {
    res.status(400).json({
      error: `target is required and must be one of: ${DISPUTE_RESOLUTION_TARGETS.join(', ')}`,
    })
    return
  }

  const result = resolveDispute(req.params.id, req.user!.userId, req.user!.role, target)

  if (!result.success) {
    const status = result.error === 'Vault not found' ? 404 : 409
    res.status(status).json({ error: result.error })
    return
  }

  updateAnalyticsSummary()
  res.status(200).json({ message: 'Vault dispute resolved', id: req.params.id, status: target })
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
