import { Router, type Request, type Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import {
  IdempotencyConflictError,
  getIdempotentResponse,
  hashRequestPayload,
  saveIdempotentResponse,
} from '../services/idempotency.js'
import { buildVaultCreationPayload } from '../services/soroban.js'
import { createVaultWithMilestones, getVaultById as getStoredVaultById, listVaults } from '../services/vaultStore.js'
import { normalizeCreateVaultInput, validateCreateVaultInput } from '../services/vaultValidation.js'
import { createAuditLog } from '../lib/audit-logs.js'
import type { PersistedVault, VaultCreateResponse } from '../types/vaults.js'

export const vaultsRouter = Router()

export let vaults: PersistedVault[] = []

export const setVaults = (newVaults: PersistedVault[]) => {
  vaults = newVaults
}

export type VaultStatus = PersistedVault['status']

export const cancelVaultById = (
  id: string,
):
  | { vault: PersistedVault; previousStatus: VaultStatus }
  | { error: 'not_found' | 'already_cancelled' | 'not_cancellable'; currentStatus?: VaultStatus } => {
  const vault = vaults.find((entry) => entry.id === id)

  if (!vault) {
    return { error: 'not_found' }
  }

  if (vault.status === 'cancelled') {
    return { error: 'already_cancelled', currentStatus: vault.status }
  }

  if (vault.status !== 'active' && vault.status !== 'draft') {
    return { error: 'not_cancellable', currentStatus: vault.status }
  }

  const previousStatus = vault.status
  vault.status = 'cancelled'

  return { vault, previousStatus }
}

vaultsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endDate', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    const result = await listVaults()

    let filtered = result as unknown as Array<Record<string, unknown>>

    if (req.filters) {
      filtered = applyFilters(filtered, req.filters)
    }

    if (req.sort) {
      filtered = applySort(filtered, req.sort)
    }

    const paginated = paginateArray(filtered, req.pagination!)
    res.json(paginated)
  },
)

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

  try {
    const { vault } = await createVaultWithMilestones(input)
    vaults = [vault, ...vaults.filter((entry) => entry.id !== vault.id)]

    const responseBody: VaultCreateResponse = {
      vault,
      onChain: buildVaultCreationPayload(input, vault),
      idempotency: { key: idempotencyKey, replayed: false },
    }

    if (idempotencyKey) {
      await saveIdempotentResponse(idempotencyKey, requestHash, vault.id, responseBody)
    }

    const actorUserId = req.header('x-user-id') ?? input.creator ?? 'unknown'
    createAuditLog({
      actor_user_id: actorUserId,
      action: 'vault.created',
      target_type: 'vault',
      target_id: vault.id,
      metadata: {
        creator: input.creator ?? null,
        amount: input.amount,
      },
    })

    res.status(201).json(responseBody)
  } catch {
    res.status(500).json({ error: 'Failed to create vault.' })
  }
})

vaultsRouter.get('/:id', async (req: Request, res: Response) => {
  const localVault = vaults.find((entry) => entry.id === req.params.id)
  const vault = localVault ?? (await getStoredVaultById(req.params.id))

  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  res.json(vault)
})

vaultsRouter.post('/:id/cancel', (req: Request, res: Response) => {
  const cancelResult = cancelVaultById(req.params.id)

  if ('error' in cancelResult) {
    const status = cancelResult.error === 'not_found' ? 404 : 409
    res.status(status).json({ error: cancelResult.error, currentStatus: cancelResult.currentStatus })
    return
  }

  const actorUserId = req.header('x-user-id') ?? 'unknown'
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null

  createAuditLog({
    actor_user_id: actorUserId,
    action: 'vault.cancelled',
    target_type: 'vault',
    target_id: cancelResult.vault.id,
    metadata: {
      previousStatus: cancelResult.previousStatus,
      newStatus: cancelResult.vault.status,
      reason,
    },
  })

  res.status(200).json({ vault: cancelResult.vault })
})
