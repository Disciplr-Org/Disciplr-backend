import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'

const mockCreateMilestoneWithThreshold = jest.fn<any>()
const mockGetVaultById = jest.fn<any>()

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: jest.fn((_req: any, _res: any, next: any) => next()),
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireUser: jest.fn((_req: any, _res: any, next: any) => next()),
  requireVerifier: jest.fn((_req: any, _res: any, next: any) => next()),
}))

jest.unstable_mockModule('../services/milestones.js', () => ({
  createMilestoneWithThreshold: mockCreateMilestoneWithThreshold,
  getMilestonesByVaultId: jest.fn(),
  getMilestoneById: jest.fn(),
  verifyMilestone: jest.fn(),
  validateMilestone: jest.fn(),
  allMilestonesVerified: jest.fn(),
  allMilestonesMetThreshold: jest.fn(),
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  recordMilestoneApproval: jest.fn(),
  hasVerifierVoted: jest.fn(),
  getMilestoneApprovalProgress: jest.fn(),
  getMilestoneApprovals: jest.fn(),
  DuplicateVerifierVoteError: class DuplicateVerifierVoteError extends Error {},
  getVerifierProfile: jest.fn(),
}))

jest.unstable_mockModule('../services/vaultTransitions.js', () => ({
  completeVault: jest.fn(),
  transitionVaultStatus: jest.fn(),
}))

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  getVaultById: mockGetVaultById,
}))

jest.unstable_mockModule('../db/index.js', () => ({
  default: { transaction: jest.fn() },
}))

const { milestonesRouter } = await import('../routes/milestones.js')

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/vaults/:vaultId/milestones', milestonesRouter)
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message })
  })
  return app
}

describe('POST /api/vaults/:vaultId/milestones approvalThreshold', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetVaultById.mockResolvedValue({
      id: 'vault-1',
      status: 'active',
      verifier: 'verifier-1',
    })
    mockCreateMilestoneWithThreshold.mockImplementation(
      (vaultId: string, description: string, approvalThreshold: number, verifierId: string) => ({
        id: 'milestone-1',
        vaultId,
        description,
        approvalThreshold,
        verifierId,
      }),
    )
  })

  it('creates a milestone with the requested approval threshold', async () => {
    const response = await request(buildApp())
      .post('/api/vaults/vault-1/milestones')
      .send({ description: 'Ship the release', approvalThreshold: 3 })

    expect(response.status).toBe(201)
    expect(response.body.approvalThreshold).toBe(3)
    expect(mockCreateMilestoneWithThreshold).toHaveBeenCalledWith(
      'vault-1',
      'Ship the release',
      3,
      'verifier-1',
    )
  })

  it('defaults approvalThreshold to one when omitted', async () => {
    const response = await request(buildApp())
      .post('/api/vaults/vault-1/milestones')
      .send({ description: 'Ship the release' })

    expect(response.status).toBe(201)
    expect(mockCreateMilestoneWithThreshold).toHaveBeenCalledWith(
      'vault-1',
      'Ship the release',
      1,
      'verifier-1',
    )
  })

  it.each([0, -1, 1.5, '2'])('rejects invalid approvalThreshold %p', async (approvalThreshold) => {
    const response = await request(buildApp())
      .post('/api/vaults/vault-1/milestones')
      .send({ description: 'Ship the release', approvalThreshold })

    expect(response.status).toBe(400)
    expect(response.body.error).toContain('positive integer')
    expect(mockCreateMilestoneWithThreshold).not.toHaveBeenCalled()
  })
})
