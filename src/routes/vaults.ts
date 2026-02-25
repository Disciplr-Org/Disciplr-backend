import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'

export const vaultsRouter = Router()

type VaultStatus = 'active' | 'completed' | 'failed' | 'cancelled'
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

export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

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
    milestones,
  } = req.body as {
    creator?: string
    amount?: string
    endTimestamp?: string
    successDestination?: string
    failureDestination?: string
    milestones?: Array<{
      id?: string
      title?: string
      verifierId?: string
    }>
  }

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    res.status(400).json({
      error: 'Missing required fields: creator, amount, endTimestamp, successDestination, failureDestination',
    })
    return
  }

  if (milestones && (!Array.isArray(milestones) || milestones.some((m) => !m.title || !m.verifierId))) {
    res.status(400).json({
      error: 'If provided, milestones must be an array with title and verifierId for each milestone',
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
    milestones: (milestones ?? []).map((milestone) => ({
      id: milestone.id ?? makeId('ms'),
      title: milestone.title as string,
      verifierId: milestone.verifierId as string,
      status: 'pending',
      validatedAt: null,
      validatedBy: null,
    })),
    validationEvents: [],
    domainEvents: [],
  }

  vaults.push(vault)
  res.status(201).json(vault)
})

vaultsRouter.get('/:id', (req: Request, res: Response) => {
  const vault = vaults.find((v) => v.id === req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  res.json(vault)
})

vaultsRouter.post('/:id/milestones/:mid/validate', (req: Request, res: Response) => {
  const vault = vaults.find((v) => v.id === req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const milestone = vault.milestones.find((m) => m.id === req.params.mid)
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
  vault.domainEvents.push(milestoneValidatedEvent)

  if (vault.milestones.length > 0 && vault.milestones.every((m) => m.status === 'validated')) {
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
      ...(vault.status === 'completed'
        ? [vault.domainEvents[vault.domainEvents.length - 1]]
        : []),
    ],
  })
})
