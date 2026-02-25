import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { createAuditLog } from '../lib/audit-logs.js'

export const vaultsRouter = Router()

export type VaultStatus = 'active' | 'completed' | 'failed' | 'cancelled'

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
}

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

const getVaultById = (id: string): Vault | undefined => vaults.find((vault) => vault.id === id)

export const cancelVaultById = (id: string):
  | { vault: Vault; previousStatus: VaultStatus }
  | { error: 'not_found' | 'already_cancelled' | 'not_cancellable'; currentStatus?: VaultStatus } => {
  const vault = getVaultById(id)
  if (!vault) {
    return { error: 'not_found' }
  }

  if (vault.status === 'cancelled') {
    return { error: 'already_cancelled', currentStatus: vault.status }
  }

  if (vault.status !== 'active') {
    return { error: 'not_cancellable', currentStatus: vault.status }
  }

  const previousStatus = vault.status
  vault.status = 'cancelled'
  return { vault, previousStatus }
}

vaultsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req: Request, res: Response) => {
    let result = [...vaults]

    if (req.filters) {
      result = applyFilters(result, req.filters)
    }

    if (req.sort) {
      result = applySort(result, req.sort)
    }

    const paginatedResult = paginateArray(result, req.pagination!)

    res.json(paginatedResult)
  }
)

vaultsRouter.post('/', (req: Request, res: Response) => {
  const {
    creator,
    amount,
    endTimestamp,
    successDestination,
    failureDestination,
  } = req.body as Record<string, string>

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    res.status(400).json({
      error: 'Missing required fields: creator, amount, endTimestamp, successDestination, failureDestination',
    })
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
  }

  vaults.push(vault)

  const actorUserId = req.header('x-user-id') ?? creator
  createAuditLog({
    actor_user_id: actorUserId,
    action: 'vault.created',
    target_type: 'vault',
    target_id: vault.id,
    metadata: {
      creator,
      amount,
      endTimestamp,
    },
  })

  res.status(201).json(vault)
})

vaultsRouter.get('/:id', (req: Request, res: Response) => {
  const vault = getVaultById(req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  res.json(vault)
})

vaultsRouter.post('/:id/cancel', (req: Request, res: Response) => {
  const actorUserId = req.header('x-user-id')
  const actorRole = req.header('x-user-role') ?? 'user'
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null

  if (!actorUserId) {
    res.status(400).json({ error: 'Missing x-user-id header' })
    return
  }

  const existingVault = getVaultById(req.params.id)
  if (!existingVault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const canCancel = actorUserId === existingVault.creator || actorRole === 'admin'
  if (!canCancel) {
    res.status(403).json({ error: 'Only the creator or an admin can cancel this vault' })
    return
  }

  const cancelResult = cancelVaultById(req.params.id)
  if ('error' in cancelResult) {
    if (cancelResult.error === 'already_cancelled') {
      res.status(409).json({ error: 'Vault is already cancelled' })
      return
    }

    if (cancelResult.error === 'not_cancellable') {
      res.status(409).json({
        error: `Vault cannot be cancelled from status: ${cancelResult.currentStatus}`,
      })
      return
    }

    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const auditLog = createAuditLog({
    actor_user_id: actorUserId,
    action: 'vault.cancelled',
    target_type: 'vault',
    target_id: cancelResult.vault.id,
    metadata: {
      previousStatus: cancelResult.previousStatus,
      newStatus: cancelResult.vault.status,
      actorRole,
      reason,
    },
  })

  res.status(200).json({
    vault: cancelResult.vault,
    auditLogId: auditLog.id,
  })
})
