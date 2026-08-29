import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import { randomUUID } from 'node:crypto'

process.env.JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'fallback-access-secret'
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'fallback-access-secret'

const createChain = (result: any[]) => {
  const chain: any = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(result[0] || null),
    returning: jest.fn().mockResolvedValue(result),
    count: jest.fn().mockResolvedValue([{ count: String(result.length) }]),
    insert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockResolvedValue(result.length),
    limit: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
  }
  chain.then = (onFulfilled: any) => Promise.resolve(result).then(onFulfilled)
  return chain
}

const milestoneResult: any[] = []
const mockTables = {
  vaults: createChain([]),
  milestones: createChain(milestoneResult),
  'milestone_events': createChain([]),
  'milestone_approvals': createChain([]),
}

const createMockClient = () => {
  return Object.assign(
    (table: string) => mockTables[table] || mockClient,
    mockTables,
    { fn: { now: () => 'NOW()' } }
  ) as any
}

const mockClient = createMockClient()

const mockDb = Object.assign(
  (table: string) => mockClient[table] || mockClient,
  {
    transaction: jest.fn(async (fn: any) => fn(mockClient)),
    ...mockClient,
  }
) as any

jest.unstable_mockModule('../db/index.js', () => ({
  default: mockDb,
}))

const { MilestoneRepositoryEnhanced } = await import('../repositories/milestoneRepositoryEnhanced.js')

describe('MilestoneRepositoryEnhanced transactional invariants', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    milestoneResult.length = 0
    mockTables.milestones.returning.mockResolvedValue([])
    mockTables['milestone_events'].returning.mockResolvedValue([])
  })

  it('verifyMilestoneAtomic updates milestone and emits event', async () => {
    const repo = new MilestoneRepositoryEnhanced(mockDb as any)
    const milestoneId = 'ms-1'
    const verifierId = 'verifier-1'

    mockTables.milestones.first.mockResolvedValue({
      id: milestoneId,
      vault_id: 'vault-1',
      status: 'pending',
      criteria: { verifierId: 'verifier-1' },
    })
    mockTables.milestones.returning.mockResolvedValue([{
      id: milestoneId,
      vault_id: 'vault-1',
      status: 'approved',
      updated_at: new Date().toISOString(),
      criteria: { verifierId: 'verifier-1', verifiedBy: verifierId, evidenceHash: 'abc123' },
    }])
    mockTables['milestone_events'].returning.mockResolvedValue([{
      id: randomUUID(),
      user_id: verifierId,
      vault_id: 'vault-1',
      name: 'milestone.verified',
      status: 'success',
      timestamp: new Date().toISOString(),
    }])

    const result = await repo.verifyMilestoneAtomic(milestoneId, verifierId, 'abc123')

    expect(result).not.toBeNull()
    expect(result!.id).toBe(milestoneId)
    expect(mockTables['milestone_events'].insert).toHaveBeenCalledWith({
      user_id: verifierId,
      vault_id: 'vault-1',
      name: 'milestone.verified',
      status: 'success',
      timestamp: 'NOW()',
    })
  })

  it('verifyMilestoneAtomic is idempotent for already approved milestone', async () => {
    const repo = new MilestoneRepositoryEnhanced(mockDb as any)
    const milestoneId = 'ms-1'
    const verifierId = 'verifier-1'

    mockTables.milestones.first.mockResolvedValue({
      id: milestoneId,
      vault_id: 'vault-1',
      status: 'approved',
      criteria: { verifierId: 'verifier-1' },
    })

    const result = await repo.verifyMilestoneAtomic(milestoneId, verifierId, 'abc123')

    expect(result).not.toBeNull()
    expect(result!.status).toBe('approved')
    expect(mockTables.milestones.update).not.toHaveBeenCalled()
  })

  it('approveMilestoneAtomic updates milestone and emits event', async () => {
    const repo = new MilestoneRepositoryEnhanced(mockDb as any)
    const milestoneId = 'ms-1'
    const verifiedBy = 'verifier-1'

    mockTables.milestones.first.mockResolvedValue({
      id: milestoneId,
      vault_id: 'vault-1',
      status: 'pending',
    })
    mockTables.milestones.returning.mockResolvedValue([{
      id: milestoneId,
      vault_id: 'vault-1',
      status: 'approved',
      updated_at: new Date().toISOString(),
    }])
    mockTables['milestone_events'].returning.mockResolvedValue([{
      id: randomUUID(),
      user_id: verifiedBy,
      vault_id: 'vault-1',
      name: 'milestone.approved',
      status: 'success',
      timestamp: new Date().toISOString(),
    }])

    const result = await repo.approveMilestoneAtomic(milestoneId, verifiedBy)

    expect(result).not.toBeNull()
    expect(result!.status).toBe('approved')
    expect(mockTables['milestone_events'].insert).toHaveBeenCalledWith({
      user_id: verifiedBy,
      vault_id: 'vault-1',
      name: 'milestone.approved',
      status: 'success',
      timestamp: 'NOW()',
    })
  })

  it('allMetThreshold enforces veto math correctly', async () => {
    const repo = new MilestoneRepositoryEnhanced(mockDb as any)

    mockTables.milestones.first.mockResolvedValue({
      id: 'ms-1',
      vault_id: 'vault-1',
      status: 'pending',
      criteria: { approvalThreshold: 2, totalVerifiers: 2 },
    })

    const result = await repo.allMetThreshold('vault-1', { 'ms-1': 1 }, {}, { 'ms-1': 2 })
    expect(result).toBe(false)
  })

  it('allMetThreshold returns true when threshold is met', async () => {
    const repo = new MilestoneRepositoryEnhanced(mockDb as any)
    milestoneResult.push({
      id: 'ms-1',
      vault_id: 'vault-1',
      status: 'pending',
      criteria: { approvalThreshold: 2, totalVerifiers: 2 },
    })

    const result = await repo.allMetThreshold('vault-1', { 'ms-1': 2 }, {}, { 'ms-1': 2 })
    expect(result).toBe(true)
  })

  it('verifyMilestoneAtomic returns null for missing milestone', async () => {
    const repo = new MilestoneRepositoryEnhanced(mockDb as any)

    mockTables.milestones.first.mockResolvedValue(null)

    const result = await repo.verifyMilestoneAtomic('missing', 'verifier-1')
    expect(result).toBeNull()
  })

  it('transaction parameter is used for all queries', async () => {
    const repo = new MilestoneRepositoryEnhanced(mockDb as any)

    const trxMilestones = createChain([])
    const trxEvents = createChain([])
    const trx = Object.assign(
      (table: string) => {
        if (table === 'milestones') return trxMilestones
        if (table === 'milestone_events') return trxEvents
        return mockClient
      },
      { milestones: trxMilestones, 'milestone_events': trxEvents, fn: { now: () => 'NOW()' } }
    ) as any

    trxMilestones.first.mockResolvedValue(null)

    const result = await repo.verifyMilestoneAtomic('ms-1', 'verifier-1', undefined, trx)
    expect(result).toBeNull()
    expect(mockTables.milestones.where).not.toHaveBeenCalled()
    expect(trxMilestones.where).toHaveBeenCalled()
  })
})
