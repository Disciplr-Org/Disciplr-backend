/**
 * Route-level integration tests for the milestone lifecycle endpoints
 * (anchored at src/routes/milestones.ts).
 *
 * Covers success, failure, empty, retry, and permission states for:
 *   POST   /api/vaults/:vaultId/milestones             (create)
 *   GET    /api/vaults/:vaultId/milestones             (list)
 *   PATCH  /api/vaults/:vaultId/milestones/:id/verify  (verify)
 *   POST   /api/vaults/:vaultId/milestones/:id/validate
 *   POST   /api/vaults/:vaultId/milestones/:id/approve
 *   GET    /api/vaults/:vaultId/milestones/:id/approval-status
 *
 * The in-memory milestone service (src/services/milestones.js) is used for
 * real — seeding a milestone in the test populates the same table the router
 * reads, so the full create → verify → vault-completion flow is exercised.
 * The DB-backed surfaces (repo reads, vault transitions) are mocked.
 */
import express from 'express'
import request from 'supertest'
import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import { DuplicateVerifierVoteError } from '../services/verifiers.js'

const VAULT_ID = '00000000-0000-0000-0000-000000000000'
const WALLET_HEADERS = {
  'x-wallet-address': '0x' + 'a'.repeat(40),
  'x-network-id': 'testnet',
}

// ---------------------------------------------------------------------------
// Controllable test state
// ---------------------------------------------------------------------------
let authenticatedUser: { userId: string; role: string } | null = { userId: 'user-1', role: 'USER' }
let currentVault: any = {
  id: VAULT_ID,
  status: 'active',
  creator: 'user-1',
  verifier: 'verifier-1',
}

const mockGetVaultById = jest.fn<any>()
const mockTransitionVaultStatus = jest.fn<any>()
const mockGetVerifierProfile = jest.fn<any>()
const mockHasVerifierVoted = jest.fn<any>()
const mockGetMilestoneApprovalProgress = jest.fn<any>()
const mockRecordMilestoneApproval = jest.fn<any>()
const mockGetMilestoneApprovals = jest.fn<any>()

// DB rows served to the (mocked) milestone repository.
const dbState: Record<string, any[]> = {
  milestones: [],
  milestone_events: [],
  milestone_approvals: [],
}

function makeDb() {
  const db: any = (table: string) => {
    const rows = dbState[table] ?? []
    const q: any = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(rows[0] ?? null),
    }
    q.then = (onFulfilled: any, onRejected: any) => Promise.resolve(rows).then(onFulfilled, onRejected)
    return q
  }
  db.transaction = async (cb: any) => cb({})
  return db
}

// ---------------------------------------------------------------------------
// Module mocks (must be registered before the router import)
// ---------------------------------------------------------------------------
jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (authenticatedUser) req.user = authenticatedUser as any
    next()
  },
}))

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  getVaultById: mockGetVaultById,
}))

jest.unstable_mockModule('../services/vaultTransitions.js', () => ({
  transitionVaultStatus: mockTransitionVaultStatus,
}))

jest.unstable_mockModule('../db/index.js', () => ({
  default: makeDb(),
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  getVerifierProfile: mockGetVerifierProfile,
  hasVerifierVoted: mockHasVerifierVoted,
  getMilestoneApprovalProgress: mockGetMilestoneApprovalProgress,
  recordMilestoneApproval: mockRecordMilestoneApproval,
  getMilestoneApprovals: mockGetMilestoneApprovals,
  DuplicateVerifierVoteError,
}))

const { milestonesRouter } = await import('../routes/milestones.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

// Real in-memory milestone service — shared instance with the router.
const {
  createMilestoneWithThreshold,
  resetMilestonesTable,
  resetMilestones,
  getMilestoneById,
} = await import('../services/milestones.js')

const app = express()
app.use(express.json())
app.use('/api/vaults/:vaultId/milestones', milestonesRouter)
app.use(errorHandler)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const validCreateBody = () => ({
  title: 'Lifecycle milestone',
  dueDate: '2030-02-01T00:00:00.000Z',
  amount: '300',
  approvalThreshold: 1,
})

function seedMilestone(overrides: Partial<ReturnType<typeof createMilestoneWithThreshold>> = {}) {
  const m = createMilestoneWithThreshold(VAULT_ID, 'Seeded milestone', 1, 'verifier-1')
  return { ...m, ...overrides }
}

function reset() {
  jest.clearAllMocks()
  resetMilestonesTable()
  resetMilestones()
  dbState.milestones = []
  dbState.milestone_events = []
  dbState.milestone_approvals = []
  authenticatedUser = { userId: 'user-1', role: 'USER' }
  currentVault = { id: VAULT_ID, status: 'active', creator: 'user-1', verifier: 'verifier-1' }
  mockGetVaultById.mockResolvedValue(currentVault)
  mockTransitionVaultStatus.mockResolvedValue({ success: true })
  mockGetVerifierProfile.mockResolvedValue({ status: 'approved' })
  mockHasVerifierVoted.mockResolvedValue(false)
  mockGetMilestoneApprovalProgress.mockResolvedValue({ isComplete: false, isRejected: false })
  mockRecordMilestoneApproval.mockResolvedValue({ id: 'app-1', approvalStatus: 'approved' })
  mockGetMilestoneApprovals.mockResolvedValue({ approved: [], rejected: [], pending: [] })
}

beforeEach(reset)

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------
describe('POST /api/vaults/:vaultId/milestones — create lifecycle', () => {
  it('creates a milestone for the vault owner (success)', async () => {
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones`)
      .set(WALLET_HEADERS)
      .send(validCreateBody())

    expect(res.status).toBe(201)
    expect(res.body.id).toMatch(/^ms-[0-9]+-[a-z0-9]+$/i)
    expect(res.body.vaultId).toBe(VAULT_ID)
    expect(res.body.title).toBe('Lifecycle milestone')
    expect(res.body.verified).toBe(false)
    expect(res.body.idempotency).toEqual({ key: null, replayed: false })
  })

  it('rejects an invalid payload with 400 (failure)', async () => {
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones`)
      .set(WALLET_HEADERS)
      .send({ amount: '300' }) // missing title

    expect(res.status).toBe(400)
  })

  it('rejects a non-positive approvalThreshold with 400 (boundary)', async () => {
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones`)
      .set(WALLET_HEADERS)
      .send({ ...validCreateBody(), approvalThreshold: 0 })

    expect(res.status).toBe(400)
  })

  it('rejects milestones on a non-active vault with 409 (state invariant)', async () => {
    currentVault = { ...currentVault, status: 'pending' }
    mockGetVaultById.mockResolvedValue(currentVault)

    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones`)
      .set(WALLET_HEADERS)
      .send(validCreateBody())

    expect(res.status).toBe(409)
  })

  it('rejects a non-owner with 403 (permission)', async () => {
    authenticatedUser = { userId: 'someone-else', role: 'USER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones`)
      .set(WALLET_HEADERS)
      .send(validCreateBody())

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/do not own/i)
  })

  it('rejects an admin-less unauthenticated request with 401 (permission)', async () => {
    authenticatedUser = null
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones`)
      .set(WALLET_HEADERS)
      .send(validCreateBody())

    expect(res.status).toBe(401)
  })

  it('rejects an unknown vault with 404 (failure)', async () => {
    mockGetVaultById.mockResolvedValue(null)
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones`)
      .set(WALLET_HEADERS)
      .send(validCreateBody())

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET / — list
// ---------------------------------------------------------------------------
describe('GET /api/vaults/:vaultId/milestones — list', () => {
  it('returns the milestone list for a vault (success)', async () => {
    dbState.milestones = [
      {
        id: 'ms-1-aaa',
        vault_id: VAULT_ID,
        title: 'Step 1',
        description: 'Step 1',
        status: 'pending',
        created_at: '2030-01-01T00:00:00.000Z',
        updated_at: '2030-01-01T00:00:00.000Z',
      },
    ]
    const res = await request(app).get(`/api/vaults/${VAULT_ID}/milestones`)

    expect(res.status).toBe(200)
    expect(res.body.milestones).toHaveLength(1)
    expect(res.body.milestones[0]).toMatchObject({
      id: 'ms-1-aaa',
      vaultId: VAULT_ID,
      title: 'Step 1',
      status: 'pending',
    })
  })

  it('returns an empty milestones array for a vault with none (empty state)', async () => {
    const res = await request(app).get(`/api/vaults/${VAULT_ID}/milestones`)

    expect(res.status).toBe(200)
    expect(res.body.milestones).toEqual([])
  })

  it('returns 404 for an unknown vault (failure)', async () => {
    mockGetVaultById.mockResolvedValue(null)
    const res = await request(app).get(`/api/vaults/${VAULT_ID}/milestones`)

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id/verify
// ---------------------------------------------------------------------------
describe('PATCH /api/vaults/:vaultId/milestones/:id/verify — verify', () => {
  it('verifies a milestone without completing the vault when others remain (success)', async () => {
    const m1 = seedMilestone()
    const m2 = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .patch(`/api/vaults/${VAULT_ID}/milestones/${m1.id}/verify`)
      .set(WALLET_HEADERS)

    expect(res.status).toBe(200)
    expect(res.body.milestone.verified).toBe(true)
    expect(res.body.vaultCompleted).toBe(false)
    expect(getMilestoneById(m1.id)!.verified).toBe(true)
    expect(getMilestoneById(m2.id)!.verified).toBe(false)
  })

  it('completes the vault when all milestones are verified (boundary)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .patch(`/api/vaults/${VAULT_ID}/milestones/${m.id}/verify`)
      .set(WALLET_HEADERS)

    expect(res.status).toBe(200)
    expect(res.body.vaultCompleted).toBe(true)
    expect(mockTransitionVaultStatus).toHaveBeenCalledWith(expect.anything(), VAULT_ID, 'completed')
  })

  it('returns 404 for an unknown milestone (failure)', async () => {
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .patch(`/api/vaults/${VAULT_ID}/milestones/ms-999-nope/verify`)
      .set(WALLET_HEADERS)

    expect(res.status).toBe(404)
  })

  it('rejects a non-verifier with 403 (permission)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'user-1', role: 'USER' }
    const res = await request(app)
      .patch(`/api/vaults/${VAULT_ID}/milestones/${m.id}/verify`)
      .set(WALLET_HEADERS)

    expect(res.status).toBe(403)
  })

  it('rejects a malformed milestone id with 400 (boundary)', async () => {
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .patch(`/api/vaults/${VAULT_ID}/milestones/not-an-id/verify`)
      .set(WALLET_HEADERS)

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/validate
// ---------------------------------------------------------------------------
describe('POST /api/vaults/:vaultId/milestones/:id/validate — validate', () => {
  const evidenceHash = 'a'.repeat(64)

  it('validates a milestone as the assigned verifier (success)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/validate`)
      .set(WALLET_HEADERS)
      .send({ evidenceHash })

    expect(res.status).toBe(200)
    expect(res.body.milestone.verified).toBe(true)
    expect(res.body.milestone.verifiedBy).toBe('verifier-1')
    expect(res.body.milestone.evidenceHash).toBe(evidenceHash)
  })

  it('completes the vault when the last milestone is validated (boundary)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/validate`)
      .set(WALLET_HEADERS)
      .send({ evidenceHash })

    expect(res.status).toBe(200)
    expect(res.body.vaultCompleted).toBe(true)
    expect(mockTransitionVaultStatus).toHaveBeenCalledWith(expect.anything(), VAULT_ID, 'completed')
  })

  it('rejects replay validation with 409 (retry/idempotent state)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const first = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/validate`)
      .set(WALLET_HEADERS)
      .send({ evidenceHash })
    expect(first.status).toBe(200)

    const replay = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/validate`)
      .set(WALLET_HEADERS)
      .send({ evidenceHash })

    expect(replay.status).toBe(409)
  })

  it('rejects a non-assigned verifier with 403 (permission)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'other-verifier', role: 'VERIFIER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/validate`)
      .set(WALLET_HEADERS)
      .send({ evidenceHash })

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/assigned verifier/i)
  })

  it('rejects a missing evidenceHash with 400 (failure)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/validate`)
      .set(WALLET_HEADERS)
      .send({})

    expect(res.status).toBe(400)
  })

  it('rejects a malformed evidenceHash with 400 (boundary)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/validate`)
      .set(WALLET_HEADERS)
      .send({ evidenceHash: 'zz-not-hex' })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/approve — multi-verifier approval
// ---------------------------------------------------------------------------
describe('POST /api/vaults/:vaultId/milestones/:id/approve — multi-verifier approval', () => {
  it('records an approval and completes the milestone + vault (success)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    // The route reads progress twice: once as the pre-vote settlement guard
    // (must be incomplete) and once after recording the vote (now complete).
    mockGetMilestoneApprovalProgress
      .mockResolvedValueOnce({
        approved: 0, rejected: 0, pending: 1, required: 1,
        isComplete: false, isRejected: false, approvalPercentage: 0,
      })
      .mockResolvedValueOnce({
        approved: 1, rejected: 0, pending: 0, required: 1,
        isComplete: true, isRejected: false, approvalPercentage: 100,
      })
    mockGetMilestoneApprovals.mockResolvedValue({
      approved: [{ id: 'app-1', verifierUserId: 'verifier-1', approvalStatus: 'approved' }],
      rejected: [],
      pending: [],
    })

    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/approve`)
      .set(WALLET_HEADERS)
      .send({ approvalStatus: 'approved' })

    expect(res.status).toBe(201)
    expect(res.body.approval.approvalStatus).toBe('approved')
    expect(res.body.milestoneCompleted).toBe(true)
    expect(res.body.vaultCompleted).toBe(true)
    expect(mockRecordMilestoneApproval).toHaveBeenCalledWith(m.id, 'verifier-1', 'approved')
  })

  it('returns 409 for a duplicate vote by the same verifier (retry safety)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    mockHasVerifierVoted.mockResolvedValue(true)

    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/approve`)
      .set(WALLET_HEADERS)
      .send({ approvalStatus: 'approved' })

    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/already voted/i)
  })

  it('maps a concurrent duplicate-vote race to 409 (DuplicateVerifierVoteError)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    mockRecordMilestoneApproval.mockRejectedValue(new DuplicateVerifierVoteError(m.id, 'verifier-1'))

    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/approve`)
      .set(WALLET_HEADERS)
      .send({ approvalStatus: 'approved' })

    expect(res.status).toBe(409)
  })

  it('rejects votes on an already-settled milestone with 409 (state invariant)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    mockGetMilestoneApprovalProgress.mockResolvedValue({
      approved: 1,
      rejected: 0,
      pending: 0,
      required: 1,
      isComplete: true,
      isRejected: false,
      approvalPercentage: 100,
    })

    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/approve`)
      .set(WALLET_HEADERS)
      .send({ approvalStatus: 'approved' })

    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/already settled/i)
  })

  it('rejects votes from a non-approved verifier profile with 403 (permission)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    mockGetVerifierProfile.mockResolvedValue({ status: 'suspended' })

    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/approve`)
      .set(WALLET_HEADERS)
      .send({ approvalStatus: 'approved' })

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/approved verifiers/i)
  })

  it('rejects an invalid approvalStatus with 400 (boundary)', async () => {
    const m = seedMilestone()
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/${m.id}/approve`)
      .set(WALLET_HEADERS)
      .send({ approvalStatus: 'maybe' })

    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown milestone (failure)', async () => {
    authenticatedUser = { userId: 'verifier-1', role: 'VERIFIER' }
    const res = await request(app)
      .post(`/api/vaults/${VAULT_ID}/milestones/ms-999-nope/approve`)
      .set(WALLET_HEADERS)
      .send({ approvalStatus: 'approved' })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /:id/approval-status
// ---------------------------------------------------------------------------
describe('GET /api/vaults/:vaultId/milestones/:id/approval-status', () => {
  it('returns the approval status for a milestone (success)', async () => {
    dbState.milestones = [
      {
        id: 'ms-1-aaa',
        vault_id: VAULT_ID,
        description: 'Step 1',
        // criteria is a JSONB column — the pg driver parses it to an object.
        criteria: { approvalThreshold: 2 },
      },
    ]
    mockGetMilestoneApprovalProgress.mockResolvedValue({
      approved: 1,
      rejected: 0,
      pending: 1,
      required: 2,
      isComplete: false,
      isRejected: false,
      approvalPercentage: 50,
    })

    const res = await request(app).get(`/api/vaults/${VAULT_ID}/milestones/ms-1-aaa/approval-status`)

    expect(res.status).toBe(200)
    expect(res.body.milestone.id).toBe('ms-1-aaa')
    expect(res.body.milestone.approvalThreshold).toBe(2)
    expect(res.body.approvalStatus.required).toBe(2)
    expect(res.body.approvalStatus.isComplete).toBe(false)
  })

  it('returns 404 for an unknown milestone (failure)', async () => {
    const res = await request(app).get(`/api/vaults/${VAULT_ID}/milestones/ms-999-nope/approval-status`)
    expect(res.status).toBe(404)
  })

  it('returns 404 for an unknown vault (failure)', async () => {
    mockGetVaultById.mockResolvedValue(null)
    const res = await request(app).get(`/api/vaults/${VAULT_ID}/milestones/ms-1-aaa/approval-status`)
    expect(res.status).toBe(404)
  })
})
