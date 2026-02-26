import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware.js'
import { VaultService } from '../services/vault.service.js'
import { UserRole } from '../types/user.js'
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

export const vaultsRouter = Router()

export type VaultStatus = 'active' | 'completed' | 'failed' | 'cancelled'

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
  orgId?: string
}

export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}

vaultsRouter.get(
  '/',
  authenticate,
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    try {
      let dbVaults = []
      try {
        dbVaults = await VaultService.getVaultsByUser(req.user!.userId) as any
      } catch (err) { }
      
      let allVaults = [...vaults, ...dbVaults]
      if (req.filters) allVaults = applyFilters(allVaults, req.filters)
      if (req.sort) allVaults = applySort(allVaults, req.sort)
      if (req.pagination) allVaults = paginateArray(allVaults, req.pagination) as any

      res.json(allVaults)
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
)

vaultsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  const {
    creator, amount, endTimestamp, successDestination, failureDestination,
    milestoneHash = 'pending_hash', verifierAddress = 'pending_verifier', contractId = null
  } = req.body as Record<string, string>

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    return res.status(400).json({ error: 'Vault creation payload validation failed.' })
  }

  if (!isValidISO8601(endTimestamp)) {
    return res.status(400).json({ error: 'endTimestamp must be a valid ISO 8601' })
  }

  const normalizedEnd = parseAndNormalizeToUTC(endTimestamp)
  if (new Date(normalizedEnd).getTime() <= Date.now()) {
    return res.status(400).json({ error: 'endTimestamp must be a future date' })
  }

  const startTimestamp = utcNow()
  let dbVaultId: string | null = null;
  const idempotencyKey = req.header('idempotency-key')?.trim() || null
  const requestHash = hashRequestPayload(req.body)

  if (idempotencyKey) {
    const cached = await getIdempotentResponse(idempotencyKey, requestHash)
    if (cached) return res.status(200).json({ ...cached, idempotency: { key: idempotencyKey, replayed: true } })
  }

  try {
    const newDbVault = await VaultService.createVault({
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

    const vault: Vault = {
      id: dbVaultId,
      creator,
      amount,
      startTimestamp,
      endTimestamp: normalizedEnd,
      successDestination,
      failureDestination,
      status: 'active',
      createdAt: startTimestamp,
    }
    vaults.push(vault)

    const responseBody = {
      vault,
      onChain: buildVaultCreationPayload(req.body, vault as any),
      idempotency: { key: idempotencyKey, replayed: false },
    }

    if (idempotencyKey) await saveIdempotentResponse(idempotencyKey, requestHash, vault.id, responseBody, undefined)

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'vault.created',
      target_type: 'vault',
      target_id: vault.id,
      metadata: { creator, amount },
    })

    updateAnalyticsSummary()
    res.status(201).json(responseBody)
  } catch (error) {
    res.status(500).json({ error: 'Failed to create vault.' })
  }
})

vaultsRouter.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const dbVault = await VaultService.getVaultById(req.params.id);
    if (dbVault) return res.json(dbVault);
  } catch (error) { }

  const vault = vaults.find(v => v.id === req.params.id)
  if (!vault) return res.status(404).json({ error: 'Vault not found' })
  res.json(vault)
})

vaultsRouter.post('/:id/cancel', authenticate, async (req: Request, res: Response) => {
  const actorUserId = req.user!.userId
  const actorRole = req.user!.role
  let existingVault = await VaultService.getVaultById(req.params.id) as any
  if (!existingVault) existingVault = vaults.find(v => v.id === req.params.id)

  if (!existingVault) return res.status(404).json({ error: 'Vault not found' })
  if (req.user!.userId !== existingVault.creator && req.user!.role !== UserRole.ADMIN) return res.status(403).json({ error: 'Forbidden' })
  
  const arrayIndex = vaults.findIndex(v => v.id === req.params.id);
  if (arrayIndex !== -1) vaults[arrayIndex].status = 'cancelled';

  updateAnalyticsSummary()
  res.status(200).json({ vault: existingVault })
})

export async function cancelVaultById(id: string) {
  const vault = vaults.find(v => v.id === id)
  if (!vault) return { error: 'not_found' }
  vault.status = 'cancelled'
  return { vault, previousStatus: 'active', currentStatus: 'cancelled' }
}
