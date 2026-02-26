import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware.js'
import { VaultService } from '../services/vault.service.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { updateAnalyticsSummary } from '../db/database.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { isValidISO8601, parseAndNormalizeToUTC, utcNow } from '../utils/timestamps.js'
import {
  IdempotencyConflictError,
  getIdempotentResponse,
  hashRequestPayload,
  saveIdempotentResponse
} from '../services/idempotency.js'
import { buildVaultCreationPayload } from '../services/soroban.js'
import { requireUser } from '../middleware/rbac.js'
import { cancelVault } from '../services/vaultTransitions.js'

export const vaultsRouter = Router()

// ============================================================================
// DO NOT MODIFY OR DELETE: Required by privacy.ts and existing integrations
// ============================================================================
export type VaultStatus = 'active' | 'completed' | 'failed' | 'cancelled'

// In-memory placeholder
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

export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}
// ============================================================================

vaultsRouter.get(
  '/',
  authenticate,
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    try {
      // 1. Fetch from Database preferred
      let dbVaults = []
      try {
        dbVaults = await VaultService.getVaultsByUser(req.user!.userId) as any
      } catch (err) {
        // Fallback or ignore
      }
      
      // Merge with in-memory vaults for backwards compatibility
      let allVaults = [...vaults, ...dbVaults]
      
      if (req.filters) {
          allVaults = applyFilters(allVaults, req.filters)
      }
      if (req.sort) {
          allVaults = applySort(allVaults, req.sort)
      }
      if (req.pagination) {
          allVaults = paginateArray(allVaults, req.pagination) as any
      }

      res.json(allVaults)
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
)

vaultsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  const {
    creator,
    amount,
    endTimestamp,
    successDestination,
    failureDestination,
    milestoneHash = 'pending_hash',
    verifierAddress = 'pending_verifier',
    contractId = null
  } = req.body as Record<string, string>

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    res.status(400).json({
      error: 'Vault creation payload validation failed.',
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

  const startTimestamp = utcNow()
  let dbVaultId: string | null = null;
  const idempotencyKey = req.header('idempotency-key')?.trim() || null
  const requestHash = hashRequestPayload(req.body)

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
    }
  }

  try {
    let newDbVault = null
    try {
      newDbVault = await VaultService.createVault({
        contractId: contractId || undefined,
        creatorAddress: creator,
        amount,
        milestoneHash,
        verifierAddress,
        successDestination,
        failureDestination,
        deadline: endTimestamp
      });
      dbVaultId = newDbVault.id;
    } catch (err) {
       console.error('Database failed', err)
    }

    const id = dbVaultId || `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const vault: Vault = {
      id,
      creator,
      amount,
      startTimestamp,
      endTimestamp: normalizedEnd,
      successDestination,
      failureDestination,
      status: 'active' as const,
      createdAt: startTimestamp,
    }
    vaults.push(vault)

    const responseBody = {
      vault,
      onChain: buildVaultCreationPayload(req.body, vault as any),
      idempotency: { key: idempotencyKey, replayed: false },
    }

    if (idempotencyKey) {
      await saveIdempotentResponse(idempotencyKey, requestHash, vault.id, responseBody, undefined)
    }

    const actorUserId = (req.header('x-user-id') ?? creator) || 'unknown'
    createAuditLog({
      actor_user_id: actorUserId,
      action: 'vault.created',
      target_type: 'vault',
      target_id: vault.id,
      metadata: { creator, amount },
    })

    updateAnalyticsSummary()

    res.status(201).json(responseBody)
  } catch (error) {
    console.error('Vault creation failed', error)
    res.status(500).json({ error: 'Failed to create vault.' })
  }
})

vaultsRouter.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const dbVault = await VaultService.getVaultById(req.params.id);
    if (dbVault) {
      res.json(dbVault);
      return;
    }
  } catch (error) {
    // falls back
  }

  const vault = vaults.find(v => v.id === req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }
  res.json(vault)
})

vaultsRouter.get('/user/:address', async (req: Request, res: Response) => {
  try {
    const userVaults = await VaultService.getVaultsByUser(req.params.address);
    res.json(userVaults);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user vaults from database' });
  }
});

vaultsRouter.patch('/:id/status', async (req: Request, res: Response) => {
  const { status } = req.body;
  
  if (!Object.values(['active', 'completed', 'failed', 'cancelled']).includes(status)) {
    res.status(400).json({ error: 'Invalid vault status' });
    return;
  }

  try {
    const updatedVault = await VaultService.updateVaultStatus(req.params.id, status);
    
    if (!updatedVault) {
      res.status(404).json({ error: 'Vault not found in database' });
      return;
    }

    const arrayIndex = vaults.findIndex(v => v.id === req.params.id);
    if (arrayIndex !== -1) {
      vaults[arrayIndex].status = status;
    }

    res.json(updatedVault);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update vault status' });
  }
});

vaultsRouter.post('/:id/cancel', authenticate, async (req: Request, res: Response) => {
  const actorUserId = req.header('x-user-id') || req.user!.userId
  const actorRole = req.header('x-user-role') || req.user!.role
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null

  let existingVault: any = null
  try {
    existingVault = await VaultService.getVaultById(req.params.id)
  } catch (e) { }

  if (!existingVault) {
    existingVault = vaults.find(v => v.id === req.params.id)
  }

  if (!existingVault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const canCancel = actorUserId === existingVault.creator || actorRole === 'admin'
  if (!canCancel) {
    res.status(403).json({ error: 'Only the creator or an admin can cancel this vault' })
    return
  }
  
  const arrayIndex = vaults.findIndex(v => v.id === req.params.id);
  if (arrayIndex !== -1) {
    vaults[arrayIndex].status = 'cancelled';
  }

  createAuditLog({
    actor_user_id: actorUserId,
    action: 'vault.cancelled',
    target_type: 'vault',
    target_id: req.params.id,
    metadata: {
      newStatus: 'cancelled',
      reason
    },
  })

  updateAnalyticsSummary()

  res.status(200).json({ vault: existingVault })
})
