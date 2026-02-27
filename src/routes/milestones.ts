import { Router, Request, Response } from 'express'
import type { 
  Milestone, 
  Verifier, 
  MilestoneVerifier, 
  CreateMilestoneRequest,
  VerifierDecisionRequest,
  MilestoneDecisionSummary 
} from '../types/milestone.js'
import { ApprovalPolicyService } from '../services/approvalPolicyService.js'

export const milestonesRouter = Router()

// In-memory storage (replace with database later)
let milestones: Milestone[] = []
let verifiers: Verifier[] = []
let milestoneVerifiers: MilestoneVerifier[] = []

// Helper functions
export const setMilestones = (newMilestones: Milestone[]) => {
  milestones = newMilestones
}

export const setVerifiers = (newVerifiers: Verifier[]) => {
  verifiers = newVerifiers
}

export const setMilestoneVerifiers = (newMilestoneVerifiers: MilestoneVerifier[]) => {
  milestoneVerifiers = newMilestoneVerifiers
}

// GET /api/milestones - List all milestones
milestonesRouter.get('/', (req: Request, res: Response) => {
  const { vaultId, status } = req.query
  
  let filteredMilestones = [...milestones]
  
  if (vaultId) {
    filteredMilestones = filteredMilestones.filter(m => m.vaultId === vaultId)
  }
  
  if (status) {
    filteredMilestones = filteredMilestones.filter(m => m.status === status)
  }
  
  res.json(filteredMilestones)
})

// GET /api/milestones/:id - Get specific milestone
milestonesRouter.get('/:id', (req: Request, res: Response) => {
  const milestone = milestones.find(m => m.id === req.params.id)
  
  if (!milestone) {
    res.status(404).json({ error: 'Milestone not found' })
    return
  }
  
  // Include verifier decisions
  const verifierDecisions = milestoneVerifiers.filter(mv => mv.milestoneId === milestone.id)
  const enrichedMilestone = {
    ...milestone,
    verifierDecisions: verifierDecisions.map(mv => {
      const verifier = verifiers.find(v => v.id === mv.verifierId)
      return {
        ...mv,
        verifier: verifier ? { id: verifier.id, name: verifier.name, email: verifier.email } : null
      }
    })
  }
  
  res.json(enrichedMilestone)
})

// POST /api/milestones - Create new milestone
milestonesRouter.post('/', (req: Request, res: Response) => {
  const body: CreateMilestoneRequest = req.body
  
  const { vaultId, title, description, deadline, approvalPolicy = 'all', verifierIds } = body
  
  if (!vaultId || !title || !deadline || !verifierIds || verifierIds.length === 0) {
    res.status(400).json({ 
      error: 'Missing required fields: vaultId, title, deadline, verifierIds' 
    })
    return
  }
  
  // Validate verifiers exist
  const existingVerifiers = verifiers.filter(v => verifierIds.includes(v.id))
  if (existingVerifiers.length !== verifierIds.length) {
    res.status(400).json({ error: 'One or more verifiers not found' })
    return
  }
  
  const milestoneId = `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const now = new Date().toISOString()
  
  const milestone: Milestone = {
    id: milestoneId,
    vaultId,
    title,
    description,
    deadline,
    status: 'pending',
    approvalPolicy,
    createdAt: now,
    updatedAt: now
  }
  
  milestones.push(milestone)
  
  // Create milestone-verifier associations
  const newMilestoneVerifiers: MilestoneVerifier[] = verifierIds.map(verifierId => ({
    id: `mv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    milestoneId,
    verifierId,
    decision: 'pending',
    createdAt: now,
    updatedAt: now
  }))
  
  milestoneVerifiers.push(...newMilestoneVerifiers)
  
  res.status(201).json(milestone)
})

// POST /api/milestones/:id/decisions - Submit verifier decision
milestonesRouter.post('/:id/decisions', (req: Request, res: Response) => {
  const milestoneId = req.params.id
  const { verifierId, decision, reason }: VerifierDecisionRequest & { verifierId: string } = req.body
  
  if (!verifierId || !decision) {
    res.status(400).json({ error: 'Missing required fields: verifierId, decision' })
    return
  }
  
  if (!['approved', 'rejected'].includes(decision)) {
    res.status(400).json({ error: 'Decision must be either "approved" or "rejected"' })
    return
  }
  
  const milestone = milestones.find(m => m.id === milestoneId)
  if (!milestone) {
    res.status(404).json({ error: 'Milestone not found' })
    return
  }
  
  const milestoneVerifier = milestoneVerifiers.find(
    mv => mv.milestoneId === milestoneId && mv.verifierId === verifierId
  )
  
  if (!milestoneVerifier) {
    res.status(404).json({ error: 'Verifier not assigned to this milestone' })
    return
  }
  
  if (milestoneVerifier.decision !== 'pending') {
    res.status(400).json({ error: 'Decision already submitted' })
    return
  }
  
  // Update decision
  milestoneVerifier.decision = decision
  milestoneVerifier.reason = reason
  milestoneVerifier.decidedAt = new Date().toISOString()
  milestoneVerifier.updatedAt = new Date().toISOString()
  
  // Update milestone status based on all decisions
  const allDecisions = milestoneVerifiers.filter(mv => mv.milestoneId === milestoneId)
  const finalStatus = ApprovalPolicyService.getFinalStatus(
    allDecisions,
    milestone.approvalPolicy,
    milestone.deadline
  )
  
  milestone.status = finalStatus
  milestone.updatedAt = new Date().toISOString()
  
  res.json({
    milestoneVerifier,
    milestoneStatus: finalStatus,
    message: `Decision recorded. Milestone status: ${finalStatus}`
  })
})

// GET /api/milestones/:id/summary - Get decision summary
milestonesRouter.get('/:id/summary', (req: Request, res: Response) => {
  const milestoneId = req.params.id
  
  const milestone = milestones.find(m => m.id === milestoneId)
  if (!milestone) {
    res.status(404).json({ error: 'Milestone not found' })
    return
  }
  
  const allDecisions = milestoneVerifiers.filter(mv => mv.milestoneId === milestoneId)
  const summary = ApprovalPolicyService.getDecisionSummary(allDecisions, milestone.approvalPolicy)
  
  res.json(summary)
})

// GET /api/verifiers - List all verifiers
milestonesRouter.get('/verifiers/list', (req: Request, res: Response) => {
  const { active } = req.query
  
  let filteredVerifiers = [...verifiers]
  
  if (active !== undefined) {
    const isActive = active === 'true'
    filteredVerifiers = filteredVerifiers.filter(v => v.active === isActive)
  }
  
  res.json(filteredVerifiers)
})

// POST /api/verifiers - Create new verifier
milestonesRouter.post('/verifiers', (req: Request, res: Response) => {
  const { name, email, walletAddress } = req.body
  
  if (!name || !email) {
    res.status(400).json({ error: 'Missing required fields: name, email' })
    return
  }
  
  // Check for duplicate email
  if (verifiers.some(v => v.email === email)) {
    res.status(400).json({ error: 'Email already exists' })
    return
  }
  
  const verifierId = `verifier-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const now = new Date().toISOString()
  
  const verifier: Verifier = {
    id: verifierId,
    name,
    email,
    walletAddress,
    active: true,
    createdAt: now
  }
  
  verifiers.push(verifier)
  
  res.status(201).json(verifier)
})
