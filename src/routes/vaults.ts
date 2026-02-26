import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware.js'
import { VaultService } from '../services/vault.service.js'
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
  cancelVaultById
} from '../services/vaultStore.js'
import { normalizeCreateVaultInput, validateCreateVaultInput } from '../services/vaultValidation.js'
import { queryParser } from '../middleware/queryParser.js'
import { createAuditLog } from '../lib/audit-logs.js'
import type { VaultCreateResponse } from '../types/vaults.js'

export type VaultStatus = 'active' | 'completed' | 'failed' | 'cancelled'
type MilestoneStatus = 'pending' | 'validated' | 'rejected'

type Milestone = {
  id: string
  title: string
  verifierId: string
  status: MilestoneStatus
  validatedAt: string | null
  validatedBy: string | null
}

type ValidationEvent = {
  id: string
  vaultId: string
  milestoneId: string
  verifierId: string
  validatedAt: string
  notes: string | null
}

type DomainEvent = {
  id: string
  type: 'milestone.validated' | 'vault.state_changed'
  occurredAt: string
  payload: Record<string, string>
}

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export interface Vault {
  id: string
  creator: string
  amount: string
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  status: VaultStatus
  createdAt: string
  milestones: Milestone[]
  validationEvents: ValidationEvent[]
  domainEvents: DomainEvent[]
}

type VaultHistory = {
  id: string
  vaultId: string
  oldStatus: string | null
  newStatus: string
  reason: string
  actorUserIdOrAddress: string
  createdAt: string
  metadata: Record<string, unknown>
}

const vaultHistory: Array<VaultHistory> = []

function appendVaultHistory(
  vaultId: string,
  oldStatus: string | null,
  newStatus: string,
  reason: string,
  actorUserIdOrAddress: string,
  metadata: Record<string, unknown> = {}
) {
  vaultHistory.push({
    id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    vaultId,
    oldStatus,
    newStatus,
    reason,
    actorUserIdOrAddress,
    createdAt: new Date().toISOString(),
    metadata,
  })
}

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

export const vaultsRouter = Router()

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
      // Note: In production, pass req.filters, req.sort, and req.pagination 
      // directly to your DB query in listVaults()
      const vaults = await listVaults()
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

    const actorUserId = req.header('x-user-id') || input.creator || 'system'
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

vaultsRouter.get('/:id/history', authenticate, (req, res) => {
  const history = vaultHistory
    .filter((entry) => entry.vaultId === req.params.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  res.json({ history })
})

/**
 * GET /:id
 */
vaultsRouter.get('/:id', authenticate, async (req: Request, res: Response) => {
  const vault = await getVaultById(req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  res.json(vault)
})

vaultsRouter.post('/:id/milestones/:mid/validate', authenticate, async (req: Request, res: Response) => {
  const vault: any = await getVaultById(req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const milestone = vault.milestones.find((m: any) => m.id === req.params.mid) as any
  if (!milestone) {
    res.status(404).json({ error: 'Milestone not found in vault' })
    return
  }

  const role = req.header('x-user-role')
  const requesterId = req.header('x-user-id')

  if (role !== 'verifier') {
    res.status(403).json({ error: 'Only users with verifier role can validate milestones' })
    return
  }

  if (!requesterId) {
    res.status(400).json({ error: 'Missing x-user-id header' })
    return
  }

  if (milestone.verifierId !== requesterId) {
    res.status(403).json({
      error: 'Verifier is not assigned to this milestone',
      assignedVerifierId: milestone.verifierId,
    })
    return
  }

  if (milestone.status === 'validated') {
    res.status(409).json({ error: 'Milestone already validated' })
    return
  }

  const now = new Date().toISOString()
  const notes = typeof req.body?.notes === 'string' ? req.body.notes : null

  milestone.status = 'validated'
  milestone.validatedAt = now
  milestone.validatedBy = requesterId

  const validationEvent: ValidationEvent = {
    id: makeId('valevt'),
    vaultId: vault.id,
    milestoneId: milestone.id,
    verifierId: requesterId,
    validatedAt: now,
    notes,
  }
  vault.validationEvents = vault.validationEvents || []
  vault.validationEvents.push(validationEvent)

  const milestoneValidatedEvent: DomainEvent = {
    id: makeId('domevt'),
    type: 'milestone.validated',
    occurredAt: now,
    payload: {
      vaultId: vault.id,
      milestoneId: milestone.id,
      verifierId: requesterId,
    },
  }
  vault.domainEvents = vault.domainEvents || []
  vault.domainEvents.push(milestoneValidatedEvent)

  if (vault.milestones.length > 0 && vault.milestones.every((m: any) => m.status === 'validated')) {
    vault.status = 'completed'
    vault.domainEvents.push({
      id: makeId('domevt'),
      type: 'vault.state_changed',
      occurredAt: now,
      payload: {
        vaultId: vault.id,
        fromStatus: 'active',
        toStatus: 'completed',
      },
    })
  }

  res.status(200).json({
    vaultId: vault.id,
    milestone,
    vaultStatus: vault.status,
    validationEvent,
    emittedDomainEvents: [
      milestoneValidatedEvent,
      ...(vault.status === 'completed' ? [vault.domainEvents[vault.domainEvents.length - 1]] : []),
    ],
  })
})

/**
 * POST /:id/cancel
 */
vaultsRouter.post('/:id/cancel', authenticate, async (req: Request, res: Response) => {
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

  // Cast existingVault into right type (assuming creator exists on it from vaultStore)
  const canCancel = actorUserId === (existingVault as any).creator || actorRole === 'admin'
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
