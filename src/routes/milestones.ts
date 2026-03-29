import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireUser, requireVerifier } from '../middleware/rbac.js'
import {
  createMilestone,
  getMilestonesByVaultId,
  getMilestoneById,
  transitionMilestone,
  allMilestonesCompleted,
} from '../services/milestones.js'
import { completeVault } from '../services/vaultTransitions.js'
import { vaults } from './vaults.js'
import type { MilestoneStatus } from '../types/milestone.js'

export const milestonesRouter = Router({ mergeParams: true })

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
  'failed',
])

// POST /api/vaults/:vaultId/milestones
milestonesRouter.post('/', authenticate, requireUser, async (req: Request, res: Response) => {
  const { vaultId } = req.params
  const vault = vaults.find((v) => v.id === vaultId)

  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  if (vault.status !== 'active') {
    res.status(409).json({ error: 'Cannot add milestones to a non-active vault' })
    return
  }

  const { title, description, target_amount, deadline } = req.body
  if (!title?.trim()) {
    res.status(400).json({ error: 'title is required' })
    return
  }
  if (!target_amount) {
    res.status(400).json({ error: 'target_amount is required' })
    return
  }
  if (!deadline) {
    res.status(400).json({ error: 'deadline is required' })
    return
  }

  const id = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const milestone = await createMilestone({
    id,
    vault_id: vaultId,
    title: title.trim(),
    description: description?.trim() || null,
    target_amount,
    current_amount: '0',
    deadline,
    status: 'pending',
  })

  res.status(201).json(milestone)
})

// GET /api/vaults/:vaultId/milestones
milestonesRouter.get('/', async (req: Request, res: Response) => {
  const { vaultId } = req.params
  const vault = vaults.find((v) => v.id === vaultId)

  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const milestones = await getMilestonesByVaultId(vaultId)
  res.json({ milestones })
})

// PATCH /api/vaults/:vaultId/milestones/:id/transition
milestonesRouter.patch(
  '/:id/transition',
  authenticate,
  async (req: Request, res: Response) => {
    const { vaultId, id } = req.params
    const { status: targetStatus } = req.body as { status?: string }

    if (!targetStatus || !VALID_STATUSES.has(targetStatus)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}` })
      return
    }

    const vault = vaults.find((v) => v.id === vaultId)
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' })
      return
    }

    const milestone = await getMilestoneById(id)
    if (!milestone || milestone.vault_id !== vaultId) {
      res.status(404).json({ error: 'Milestone not found' })
      return
    }

    // RBAC: VERIFIER required for completed/failed, USER for in_progress/pending
    const role = req.user?.role
    if (
      (targetStatus === 'completed' || targetStatus === 'failed') &&
      role !== 'VERIFIER' && role !== 'ADMIN'
    ) {
      res.status(403).json({ error: 'Only verifiers can transition to completed or failed' })
      return
    }

    const result = await transitionMilestone(id, targetStatus as MilestoneStatus)
    if (!result.success) {
      res.status(409).json({ error: result.error })
      return
    }

    // Auto-complete vault when all milestones are completed
    let vaultCompleted = false
    if (targetStatus === 'completed' && vault.status === 'active') {
      const allDone = await allMilestonesCompleted(vaultId)
      if (allDone) {
        const vaultResult = await completeVault(vaultId)
        vaultCompleted = vaultResult.success
        if (vaultCompleted) {
          console.info(`[Milestones] Auto-completed vault=${vaultId} after all milestones completed`)
        }
      }
    }

    res.json({ milestone: result.milestone, vaultCompleted })
  },
)

// PATCH /api/vaults/:vaultId/milestones/:id/verify (legacy alias → transitions to 'completed')
milestonesRouter.patch(
  '/:id/verify',
  authenticate,
  requireVerifier,
  async (req: Request, res: Response) => {
    const { vaultId, id } = req.params

    const vault = vaults.find((v) => v.id === vaultId)
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' })
      return
    }

    const milestone = await getMilestoneById(id)
    if (!milestone || milestone.vault_id !== vaultId) {
      res.status(404).json({ error: 'Milestone not found' })
      return
    }

    const result = await transitionMilestone(id, 'completed')
    if (!result.success) {
      res.status(409).json({ error: result.error })
      return
    }

    let vaultCompleted = false
    if (vault.status === 'active') {
      const allDone = await allMilestonesCompleted(vaultId)
      if (allDone) {
        const vaultResult = await completeVault(vaultId)
        vaultCompleted = vaultResult.success
        if (vaultCompleted) {
          console.info(`[Milestones] Auto-completed vault=${vaultId} after all milestones verified (legacy)`)
        }
      }
    }

    res.json({ milestone: result.milestone, vaultCompleted })
  },
)
