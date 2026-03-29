import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../app.js'
import { describe, it, expect, beforeEach, beforeAll, jest } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { vaults, setVaults, vaultsRouter, type Vault } from '../routes/vaults.js'
import { milestonesRouter } from '../routes/milestones.js'
import {
  getTransitionError,
  completeVault,
  failVault,
  cancelVault,
  checkExpiredVaults,
} from '../services/vaultTransitions.js'

// Create mock functions upfront
const mockAllMilestonesCompleted = jest.fn<() => Promise<boolean>>()
const mockGetMilestoneById = jest.fn<() => Promise<any>>()
const mockGetMilestonesByVaultId = jest.fn<() => Promise<any[]>>()
const mockCreateMilestone = jest.fn<() => Promise<any>>()
const mockTransitionMilestone = jest.fn<() => Promise<any>>()

// Mock DB modules to avoid real connections
const mockQueryBuilder = {
  insert: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  first: jest.fn().mockResolvedValue(null),
  update: jest.fn().mockReturnThis(),
  del: jest.fn().mockResolvedValue(0),
  returning: jest.fn().mockResolvedValue([]),
  select: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
}
const mockDb = jest.fn(() => mockQueryBuilder)
jest.mock('../db/knex.js', () => ({ db: mockDb }))
jest.mock('../db/index.js', () => ({ __esModule: true, default: mockDb }))
jest.mock('../lib/prisma.js', () => ({ prisma: {} }))
jest.mock('../db/database.js', () => ({ updateAnalyticsSummary: jest.fn() }))
jest.mock('../services/vault.service.js', () => ({
  VaultService: {
    getVaultById: jest.fn().mockResolvedValue(null),
    createVault: jest.fn(),
    updateVaultStatus: jest.fn().mockResolvedValue(null),
    getVaultsByUser: jest.fn().mockResolvedValue([]),
  },
}))
jest.mock('../services/vaultStore.js', () => ({
  createVaultWithMilestones: jest.fn(),
  getVaultById: jest.fn(),
  listVaults: jest.fn(),
  cancelVaultById: jest.fn(),
}))

// Mock milestones service — reference the pre-created mock fns
jest.mock('../services/milestones.js', () => ({
  allMilestonesCompleted: mockAllMilestonesCompleted,
  getMilestoneById: mockGetMilestoneById,
  getMilestonesByVaultId: mockGetMilestonesByVaultId,
  createMilestone: mockCreateMilestone,
  transitionMilestone: mockTransitionMilestone,
  addMilestoneEvent: jest.fn(),
  listMilestoneEvents: jest.fn().mockReturnValue([]),
  resetMilestoneEvents: jest.fn(),
  _getRepository: jest.fn(),
  _setRepository: jest.fn(),
}))

// Helpers
const pastDate = () => new Date(Date.now() - 86_400_000).toISOString()
const futureDate = () => new Date(Date.now() + 86_400_000).toISOString()

const makeVault = (overrides: Partial<Vault> = {}): Vault => ({
  id: `vault-test-${Math.random().toString(36).slice(2, 9)}`,
  creator: 'user-creator',
  amount: '1000',
  startTimestamp: new Date().toISOString(),
  endTimestamp: futureDate(),
  successDestination: 'addr-success',
  failureDestination: 'addr-fail',
  status: 'active',
  createdAt: new Date().toISOString(),
  ...overrides,
})

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'
const tokenFor = (userId: string, role: UserRole.USER | UserRole.VERIFIER | UserRole.ADMIN) =>
  `Bearer ${jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' })}`

// Mount routes on the app for HTTP integration tests
let routesMounted = false
beforeAll(() => {
  if (!routesMounted) {
    app.use('/api/vaults', vaultsRouter)
    app.use('/api/vaults/:vaultId/milestones', milestonesRouter)
    routesMounted = true
  }
})

beforeEach(() => {
  setVaults([])
  jest.clearAllMocks()
})

// ─── getTransitionError ─────────────────────────────────────────────

describe('getTransitionError', () => {
  it('allows active → completed with all milestones completed', async () => {
    const vault = makeVault()
    vaults.push(vault)
    mockAllMilestonesCompleted.mockResolvedValue(true)

    expect(await getTransitionError(vault, 'completed')).toBeNull()
  })

  it('rejects active → completed when milestones are not all completed', async () => {
    const vault = makeVault()
    vaults.push(vault)
    mockAllMilestonesCompleted.mockResolvedValue(false)

    expect(await getTransitionError(vault, 'completed')).toMatch(/not all milestones/)
  })

  it('rejects active → completed when there are zero milestones', async () => {
    const vault = makeVault()
    vaults.push(vault)
    mockAllMilestonesCompleted.mockResolvedValue(false)

    expect(await getTransitionError(vault, 'completed')).toMatch(/not all milestones/)
  })

  it('allows active → failed when endTimestamp has passed', async () => {
    const vault = makeVault({ endTimestamp: pastDate() })
    vaults.push(vault)

    expect(await getTransitionError(vault, 'failed')).toBeNull()
  })

  it('rejects active → failed when endTimestamp is in the future', async () => {
    const vault = makeVault({ endTimestamp: futureDate() })
    vaults.push(vault)

    expect(await getTransitionError(vault, 'failed')).toMatch(/endTimestamp has not passed/)
  })

  it('allows active → cancelled by the creator', async () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    expect(await getTransitionError(vault, 'cancelled', 'alice')).toBeNull()
  })

  it('rejects active → cancelled by a non-creator', async () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    expect(await getTransitionError(vault, 'cancelled', 'bob')).toMatch(/only the creator/)
  })

  it('rejects transition from completed', async () => {
    const vault = makeVault({ status: 'completed' })
    expect(await getTransitionError(vault, 'cancelled', vault.creator)).toMatch(/already 'completed'/)
  })

  it('rejects transition from failed', async () => {
    const vault = makeVault({ status: 'failed' })
    expect(await getTransitionError(vault, 'completed')).toMatch(/already 'failed'/)
  })

  it('rejects transition from cancelled', async () => {
    const vault = makeVault({ status: 'cancelled' })
    expect(await getTransitionError(vault, 'failed')).toMatch(/already 'cancelled'/)
  })
})

// ─── completeVault ──────────────────────────────────────────────────

describe('completeVault', () => {
  it('succeeds when all milestones are completed', async () => {
    const vault = makeVault()
    vaults.push(vault)
    mockAllMilestonesCompleted.mockResolvedValue(true)

    const result = await completeVault(vault.id)
    expect(result.success).toBe(true)
    expect(vault.status).toBe('completed')
  })

  it('fails when milestones are not completed', async () => {
    const vault = makeVault()
    vaults.push(vault)
    mockAllMilestonesCompleted.mockResolvedValue(false)

    const result = await completeVault(vault.id)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not all milestones/)
  })

  it('fails when vault is not found', async () => {
    const result = await completeVault('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('fails when vault is already completed', async () => {
    const vault = makeVault({ status: 'completed' })
    vaults.push(vault)

    const result = await completeVault(vault.id)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already 'completed'/)
  })
})

// ─── failVault ──────────────────────────────────────────────────────

describe('failVault', () => {
  it('succeeds when endTimestamp has passed', async () => {
    const vault = makeVault({ endTimestamp: pastDate() })
    vaults.push(vault)

    const result = await failVault(vault.id)
    expect(result.success).toBe(true)
    expect(vault.status).toBe('failed')
  })

  it('fails when endTimestamp is in the future', async () => {
    const vault = makeVault({ endTimestamp: futureDate() })
    vaults.push(vault)

    const result = await failVault(vault.id)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/endTimestamp has not passed/)
  })
})

// ─── cancelVault ────────────────────────────────────────────────────

describe('cancelVault', () => {
  it('succeeds when requester is the creator', async () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    const result = await cancelVault(vault.id, 'alice')
    expect(result.success).toBe(true)
    expect(vault.status).toBe('cancelled')
  })

  it('fails when requester is not the creator', async () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    const result = await cancelVault(vault.id, 'bob')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/only the creator/)
  })

  it('fails when vault is in a terminal state', async () => {
    const vault = makeVault({ status: 'failed' })
    vaults.push(vault)

    const result = await cancelVault(vault.id, vault.creator)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already 'failed'/)
  })
})

// ─── checkExpiredVaults ─────────────────────────────────────────────

describe('checkExpiredVaults', () => {
  it('fails all expired active vaults', async () => {
    const v1 = makeVault({ endTimestamp: pastDate() })
    const v2 = makeVault({ endTimestamp: pastDate() })
    vaults.push(v1, v2)

    const expired = await checkExpiredVaults()
    expect(expired).toContain(v1.id)
    expect(expired).toContain(v2.id)
    expect(v1.status).toBe('failed')
    expect(v2.status).toBe('failed')
  })

  it('ignores vaults already in a terminal state', async () => {
    const v = makeVault({ endTimestamp: pastDate(), status: 'failed' })
    vaults.push(v)

    const expired = await checkExpiredVaults()
    expect(expired).toHaveLength(0)
  })

  it('returns empty array when nothing is expired', async () => {
    const v = makeVault({ endTimestamp: futureDate() })
    vaults.push(v)

    const expired = await checkExpiredVaults()
    expect(expired).toHaveLength(0)
  })
})

// ─── HTTP Routes ────────────────────────────────────────────────────

describe('POST /api/vaults/:id/cancel', () => {
  it('cancels when authenticated as the creator', async () => {
    const vault = makeVault({ creator: 'user-1' })
    vaults.push(vault)

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/cancel`)
      .set('Authorization', await tokenFor('user-1', UserRole.USER))

    expect(res.status).toBe(200)
    expect(res.body.vault.status).toBe('cancelled')
  })

  it('returns 403 when requester is not the creator', async () => {
    const vault = makeVault({ creator: 'user-1' })
    vaults.push(vault)

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/cancel`)
      .set('Authorization', await tokenFor('user-2', UserRole.USER))

    expect(res.status).toBe(403)
  })

  it('returns 401 without auth', async () => {
    const vault = makeVault()
    vaults.push(vault)

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/cancel`)

    expect(res.status).toBe(401)
  })
})

describe('Milestones routes', () => {
  it('POST creates a milestone on an active vault', async () => {
    const vault = makeVault()
    vaults.push(vault)

    const mockMilestone = {
      id: 'ms-test-1',
      vault_id: vault.id,
      title: 'First milestone',
      description: null,
      target_amount: '500',
      current_amount: '0',
      deadline: futureDate(),
      status: 'pending' as const,
    }
    mockCreateMilestone.mockResolvedValue(mockMilestone)

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones`)
      .set('Authorization', await tokenFor('user-1', UserRole.USER))
      .send({ title: 'First milestone', target_amount: '500', deadline: futureDate() })

    expect(res.status).toBe(201)
    expect(mockCreateMilestone).toHaveBeenCalled()
  })

  it('GET lists milestones for a vault', async () => {
    const vault = makeVault()
    vaults.push(vault)
    mockGetMilestonesByVaultId.mockResolvedValue([
      { id: 'ms-1', vault_id: vault.id, title: 'ms-1', target_amount: '100', current_amount: '0', deadline: futureDate(), status: 'pending' },
      { id: 'ms-2', vault_id: vault.id, title: 'ms-2', target_amount: '200', current_amount: '0', deadline: futureDate(), status: 'pending' },
    ])

    const res = await request(app)
      .get(`/api/vaults/${vault.id}/milestones`)

    expect(res.status).toBe(200)
    expect(res.body.milestones).toHaveLength(2)
  })

  it('PATCH transition works with verifier role for completed', async () => {
    const vault = makeVault()
    vaults.push(vault)

    const milestone = {
      id: 'ms-test-1',
      vault_id: vault.id,
      title: 'task 1',
      target_amount: '100',
      current_amount: '0',
      deadline: futureDate(),
      status: 'in_progress' as const,
    }
    mockGetMilestoneById.mockResolvedValue(milestone)
    mockTransitionMilestone.mockResolvedValue({
      success: true,
      milestone: { ...milestone, status: 'completed' },
    })
    mockAllMilestonesCompleted.mockResolvedValue(true)

    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/ms-test-1/transition`)
      .set('Authorization', await tokenFor('verifier-1', UserRole.VERIFIER))
      .send({ status: 'completed' })

    expect(res.status).toBe(200)
    expect(res.body.milestone.status).toBe('completed')
    expect(res.body.vaultCompleted).toBe(true)
  })

  it('PATCH transition rejects user role for completed', async () => {
    const vault = makeVault()
    vaults.push(vault)

    const milestone = {
      id: 'ms-test-1',
      vault_id: vault.id,
      title: 'task 1',
      target_amount: '100',
      current_amount: '0',
      deadline: futureDate(),
      status: 'in_progress' as const,
    }
    mockGetMilestoneById.mockResolvedValue(milestone)

    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/ms-test-1/transition`)
      .set('Authorization', await tokenFor('user-1', UserRole.USER))
      .send({ status: 'completed' })

    expect(res.status).toBe(403)
  })

  it('PATCH transition allows user role for in_progress', async () => {
    const vault = makeVault()
    vaults.push(vault)

    const milestone = {
      id: 'ms-test-1',
      vault_id: vault.id,
      title: 'task 1',
      target_amount: '100',
      current_amount: '0',
      deadline: futureDate(),
      status: 'pending' as const,
    }
    mockGetMilestoneById.mockResolvedValue(milestone)
    mockTransitionMilestone.mockResolvedValue({
      success: true,
      milestone: { ...milestone, status: 'in_progress' },
    })

    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/ms-test-1/transition`)
      .set('Authorization', await tokenFor('user-1', UserRole.USER))
      .send({ status: 'in_progress' })

    expect(res.status).toBe(200)
    expect(res.body.milestone.status).toBe('in_progress')
  })

  it('PATCH verify (legacy) works with verifier role', async () => {
    const vault = makeVault()
    vaults.push(vault)

    const milestone = {
      id: 'ms-test-1',
      vault_id: vault.id,
      title: 'task 1',
      target_amount: '100',
      current_amount: '0',
      deadline: futureDate(),
      status: 'in_progress' as const,
    }
    mockGetMilestoneById.mockResolvedValue(milestone)
    mockTransitionMilestone.mockResolvedValue({
      success: true,
      milestone: { ...milestone, status: 'completed' },
    })
    mockAllMilestonesCompleted.mockResolvedValue(true)

    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/ms-test-1/verify`)
      .set('Authorization', await tokenFor('verifier-1', UserRole.VERIFIER))

    expect(res.status).toBe(200)
    expect(res.body.milestone.status).toBe('completed')
    expect(res.body.vaultCompleted).toBe(true)
  })

  it('auto-completes vault when last milestone transitions to completed', async () => {
    const vault = makeVault()
    vaults.push(vault)

    const milestone = {
      id: 'ms-test-2',
      vault_id: vault.id,
      title: 'task 2',
      target_amount: '200',
      current_amount: '0',
      deadline: futureDate(),
      status: 'in_progress' as const,
    }
    mockGetMilestoneById.mockResolvedValue(milestone)
    mockTransitionMilestone.mockResolvedValue({
      success: true,
      milestone: { ...milestone, status: 'completed' },
    })
    mockAllMilestonesCompleted.mockResolvedValue(true)

    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/ms-test-2/transition`)
      .set('Authorization', await tokenFor('v1', UserRole.VERIFIER))
      .send({ status: 'completed' })

    expect(res.status).toBe(200)
    expect(res.body.vaultCompleted).toBe(true)
    expect(vault.status).toBe('completed')
  })
})
