import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware.js'
import { VaultService } from '../services/vault.service.js'
import { VaultStatus } from '@prisma/client'
import { updateAnalyticsSummary } from '../db/database.js'
import { createAuditLog } from '../lib/audit-logs.js'
import {
  IdempotencyConflictError,
  getIdempotentResponse,
  hashRequestPayload,
  saveIdempotentResponse
} from '../services/idempotency.js'
import { buildVaultCreationPayload } from '../services/soroban.js'
import {
  createVaultWithMilestones,
  getVaultById,
  listVaults,
  cancelVaultById
} from '../services/vaultStore.js'
import { normalizeCreateVaultInput, validateCreateVaultInput } from '../services/vaultValidation.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { isValidISO8601, parseAndNormalizeToUTC, utcNow } from '../utils/timestamps.js'
import { getPgPool } from '../db/pool.js'

export const vaultsRouter = Router()

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export interface Vault {
  id: string
  creator: string
  amount: string
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  orgId?: string
}

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}
export type { Vault, VaultStatusUpdate } from '../types/vault.js'

/**
 * GET /
 * Lists vaults with support for filtering, sorting, and pagination.
 */
vaultsRouter.get(
  '/',
  authenticate,
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    try {
      // Prioritize the service-based listing if it provides more features
      const vaults = await listVaults(req.filters, req.sort, req.pagination)
      res.json(vaults)
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
)

/**
 * POST /
 * Creates a new vault with idempotency checks and audit logging.
 */
vaultsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  const input = normalizeCreateVaultInput(req.body)
  const validation = validateCreateVaultInput(input)

  if (!validation.valid) {
    res.status(400).json({
      error: 'Vault creation payload validation failed.',
      details: validation.errors,
    })
    return
  }

  if (!isValidISO8601(endTimestamp)) {
    res.status(400).json({
      error: 'endTimestamp must be a valid ISO 8601 datetime with timezone (e.g. 2025-12-31T23:59:59Z)',
    })
    return
  }

  const normalizedEnd = parseAndNormalizeToUTC(endTimestamp)

  if (new Date(normalizedEnd).getTime() <= Date.now()) {
    res.status(400).json({
      error: 'endTimestamp must be a future date',
    })
    return
  }

  const id = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const startTimestamp = utcNow()
  const vault = {
    id,
    creator,
    amount,
    startTimestamp,
    endTimestamp: normalizedEnd,
    successDestination,
    failureDestination,
    status: 'active' as const,
    createdAt: startTimestamp,
  const idempotencyKey = req.header('idempotency-key')?.trim() || null
  const requestHash = hashRequestPayload(input)

  if (idempotencyKey) {
    try {
      const cachedResponse = await getIdempotentResponse(idempotencyKey, requestHash)
      if (cachedResponse) {
        res.status(200).json({
          ...cachedResponse,
          idempotency: { key: idempotencyKey, replayed: true },
        })
        return
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        res.status(409).json({ error: error.message })
        return
      }
      res.status(500).json({ error: 'Failed to process idempotency key.' })
      return
    }
  }

  const pool = getPgPool()
  const client = pool ? await pool.connect() : null

  try {
    if (client) await client.query('BEGIN')

    const { vault } = await createVaultWithMilestones(input, client ?? undefined)

    const responseBody = {
      vault,
      onChain: buildVaultCreationPayload(input, vault),
      idempotency: { key: idempotencyKey, replayed: false },
    }

    if (idempotencyKey) {
      await saveIdempotentResponse(idempotencyKey, requestHash, vault.id, responseBody, client ?? undefined)
    }

    const actorUserId = req.header('x-user-id') ?? input.creator
    createAuditLog({
      actor_user_id: actorUserId,
      action: 'vault.created',
      target_type: 'vault',
      target_id: vault.id,
      metadata: { creator: input.creator, amount: input.amount },
    })

    if (client) await client.query('COMMIT')

    // Trigger analytics update
    updateAnalyticsSummary()

    res.status(201).json(responseBody)
  } catch (error) {
    if (client) await client.query('ROLLBACK')
    console.error('Vault creation failed', error)
    res.status(500).json({ error: 'Failed to create vault.' })
  } finally {
    if (client) client.release()
  }
})

/**
 * GET /:id
 */
vaultsRouter.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const vault = await getVaultById(req.params.id)
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' })
      return
    }
    res.json(vault)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /:id/cancel
 */
vaultsRouter.post('/:id/cancel', authenticate, async (req: Request, res: Response) => {
  const actorUserId = req.header('x-user-id') || req.user!.userId
  const actorRole = req.header('x-user-role') || req.user!.role
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null

  const existingVault = await getVaultById(req.params.id)
  if (!existingVault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const canCancel = actorUserId === existingVault.creator || actorRole === 'admin'
  if (!canCancel) {
    res.status(403).json({ error: 'Only the creator or an admin can cancel this vault' })
    return
  }

  const cancelResult = await cancelVaultById(req.params.id)
  if ('error' in cancelResult) {
    const status = cancelResult.error === 'not_found' ? 404 : 409
    res.status(status).json({ error: cancelResult.error, currentStatus: cancelResult.currentStatus })
    return
  }

  createAuditLog({
    actor_user_id: actorUserId,
    action: 'vault.cancelled',
    target_type: 'vault',
    target_id: cancelResult.vault.id,
    metadata: {
      previousStatus: cancelResult.previousStatus,
      newStatus: cancelResult.vault.status,
      reason
    },
  })

  // Trigger analytics update
  updateAnalyticsSummary()

  res.status(200).json({ vault: cancelResult.vault })
})
