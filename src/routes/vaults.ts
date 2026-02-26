import { Router } from 'express'
import { authenticate } from '../middleware/auth.middleware.js'
import { VaultService } from '../services/vault.service.js'
import { VaultStatus } from '@prisma/client'

export const vaultsRouter = Router()

// List vaults with filtering and pagination
vaultsRouter.get('/', authenticate, async (req, res) => {
  const { status, minAmount, maxAmount, startDate, endDate, page, limit } = req.query

  try {
    const result = await VaultService.listVaults(
      {
        status: status as VaultStatus,
        minAmount: minAmount as string,
        maxAmount: maxAmount as string,
        startDate: startDate as string,
        endDate: endDate as string,
      },
      {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      },
      req.user!.userId,
      req.user!.role
    )
    res.json(result)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// Get vault detail
vaultsRouter.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params

  try {
    const vault = await VaultService.getVaultDetails(id, req.user!.userId, req.user!.role)
    res.json(vault)
  } catch (error: any) {
    const status = error.message.includes('Forbidden') ? 403 : 404
    res.status(status).json({ error: error.message })
import type { Request, Response } from 'express'
import { getPgPool } from '../db/pool.js'
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
  cancelVaultById // Assuming this is moved to vaultStore for DB persistence
} from '../services/vaultStore.js'
import { normalizeCreateVaultInput, validateCreateVaultInput } from '../services/vaultValidation.js'
import { queryParser } from '../middleware/queryParser.js'
import { createAuditLog } from '../lib/audit-logs.js'
import type { VaultCreateResponse } from '../types/vaults.js'

export const vaultsRouter = Router()

/**
 * GET /
 * Lists vaults with support for filtering, sorting, and pagination.
 */
vaultsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    // Note: In production, pass req.filters, req.sort, and req.pagination 
    // directly to your DB query in listVaults()
    const vaults = await listVaults(req.filters, req.sort, req.pagination)
    res.json(vaults)
  }
)

/**
 * POST /
 * Creates a new vault with idempotency checks and audit logging.
 */
vaultsRouter.post('/', async (req: Request, res: Response) => {
  const input = normalizeCreateVaultInput(req.body)
  const validation = validateCreateVaultInput(input)

  if (!validation.valid) {
    res.status(400).json({
      error: 'Vault creation payload validation failed.',
      details: validation.errors,
    })
    return
  }

  const idempotencyKey = req.header('idempotency-key')?.trim() || null
  const requestHash = hashRequestPayload(input)

  // 1. Idempotency Check
  if (idempotencyKey) {
    try {
      const cachedResponse = await getIdempotentResponse<VaultCreateResponse>(idempotencyKey, requestHash)
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
  const id = makeId('vault')
  const startTimestamp = new Date().toISOString()
  const vault: Vault = {
    id,
    creator,
    amount,
    startTimestamp,
    endTimestamp,
    successDestination,
    failureDestination,
    status: 'active',
    createdAt: startTimestamp,
    fundedAt: undefined,
    milestoneValidatedAt: undefined,
    cancelledAt: undefined,
    cancellation: undefined,
    history: [
      {
        id: makeId('history'),
        type: 'created' as const,
        timestamp: startTimestamp,
        actor: creator,
        role: 'creator' as const,
      },
    ],
    validationRecords: [],
  }

  const pool = getPgPool()
  const client = pool ? await pool.connect() : null

  try {
    if (client) await client.query('BEGIN')

    // 2. Database Insertion
    const { vault } = await createVaultWithMilestones(input, client ?? undefined)
    
    // 3. Prepare Payloads
    const responseBody: VaultCreateResponse = {
      vault,
      onChain: buildVaultCreationPayload(input, vault),
      idempotency: { key: idempotencyKey, replayed: false },
    }

    // 4. Persistence & Audit Log
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
vaultsRouter.get('/:id', async (req: Request, res: Response) => {
  const vault = await getVaultById(req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }
})

/**
 * POST /:id/cancel
 */
vaultsRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  const actorUserId = req.header('x-user-id')
  const actorRole = req.header('x-user-role') ?? 'user'
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null

  if (!actorUserId) {
    res.status(400).json({ error: 'Missing x-user-id header' })
    return
  }

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

  res.status(200).json({ vault: cancelResult.vault })
})