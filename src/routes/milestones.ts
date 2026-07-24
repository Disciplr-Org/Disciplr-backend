import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { enforceRBAC } from '../middleware/rbac.js'
import { MilestoneService } from '../services/milestonesDb.js'
import { MilestoneRepositoryEnhanced } from '../repositories/milestoneRepositoryEnhanced.js'
import { completeVault } from '../services/vaultTransitions.js'
import { vaults } from './vaults.js'
import { db as knexDb } from '../db/index.js'

export const milestonesRouter = Router({ mergeParams: true })

// Initialize milestone service with database connection
const milestoneRepository = new MilestoneRepositoryEnhanced(knexDb)
const milestoneService = new MilestoneService(milestoneRepository)

// POST /api/vaults/:vaultId/milestones
milestonesRouter.post('/', authenticate, enforceRBAC({ allow: ['USER'] }), async (req: Request, res: Response) => {
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

  const milestone = await milestoneService.createMilestone(vaultId, description.trim())
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

  const milestones = await milestoneService.getMilestonesByVaultId(vaultId)
  res.json({ milestones })
})

// PATCH /api/vaults/:vaultId/milestones/:id/verify
milestonesRouter.patch('/:id/verify', authenticate, enforceRBAC({ allow: ['VERIFIER'] }), async (req: Request, res: Response) => {
  const { vaultId, id } = req.params

  const vault = vaults.find((v) => v.id === vaultId)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const milestone = await milestoneService.getMilestoneById(id)
  if (!milestone || milestone.vaultId !== vaultId) {
    res.status(404).json({ error: 'Milestone not found' })
    return
  }

  const verified = await milestoneService.verifyMilestone(id)
  if (!verified) {
    res.status(404).json({ error: 'Milestone not found' })
    return
  }

  let vaultCompleted = false
  if (await milestoneService.allMilestonesVerified(vaultId) && vault.status === 'active') {
    const result = completeVault(vaultId)
    vaultCompleted = result.success
  }

  res.json({ milestone: verified, vaultCompleted })
})
