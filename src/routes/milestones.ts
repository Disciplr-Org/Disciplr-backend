import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireUser, requireVerifier } from '../middleware/rbac.js'
import {
  createMilestone,
  getMilestonesByVaultId,
  getMilestoneById,
  verifyMilestone,
  allMilestonesVerified,
} from '../services/milestones.js'
import { completeVault } from '../services/vaultTransitions.js'
import { vaults } from './vaults.js'

export const milestonesRouter = Router({ mergeParams: true })

// POST /api/vaults/:vaultId/milestones
milestonesRouter.post('/', authenticate, requireUser, (req: Request, res: Response) => {
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

  const { description } = req.body as { description?: string }
  if (!description?.trim()) {
    res.status(400).json({ error: 'description is required' })
    return
  }

  const milestone = createMilestone(vaultId, description.trim())
  res.status(201).json(milestone)
})

// GET /api/vaults/:vaultId/milestones
milestonesRouter.get('/', (req: Request, res: Response) => {
  const { vaultId } = req.params
  const vault = vaults.find((v) => v.id === vaultId)

  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const milestones = getMilestonesByVaultId(vaultId)
  res.json({ milestones })
})

// PATCH /api/vaults/:vaultId/milestones/:id/verify
milestonesRouter.patch('/:id/verify', authenticate, requireVerifier, (req: Request, res: Response) => {
  const { vaultId, id } = req.params

  const vault = vaults.find((v) => v.id === vaultId)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const milestone = getMilestoneById(id)
  if (!milestone || milestone.vaultId !== vaultId) {
    res.status(404).json({ error: 'Milestone not found' })
    return
  }

  const verified = verifyMilestone(id)
  if (!verified) {
    res.status(404).json({ error: 'Milestone not found' })
    return
  }

  let vaultCompleted = false
  if (allMilestonesVerified(vaultId) && vault.status === 'active') {
    const result = completeVault(vaultId)
    vaultCompleted = result.success
  }

  res.json({ milestone: verified, vaultCompleted })
})
