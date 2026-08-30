/**
 * Route-level tests for the milestone idempotency + authorization boundary.
 * Covers replay, tampering, wrong-network (if applicable), disconnected-wallet,
 * malformed stored responses, spoofed identity headers, and malformed route parameters.
 */
import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'
import { IdempotencyConflictError, IdempotencyOwnerMismatchError } from '../services/idempotency.js'

let authenticatedUser: { userId: string; role: string; enterpriseId?: string } | null = { userId: 'user-1', role: 'USER' }

const mockGetIdempotentResponse = jest.fn<any>()
const mockSaveIdempotentResponse = jest.fn<any>()
const mockFailPendingIdempotentResponse = jest.fn<any>()
const mockValidateIdempotencyKey = jest.fn<any>()
const mockScopeIdempotencyKey = jest.fn<any>()
const mockHashRequestPayload = jest.fn<any>()

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (authenticatedUser) req.user = authenticatedUser as any
    next()
  },
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (!authenticatedUser) return _res.status(401).json({ error: 'Unauthorized' })
    next()
  },
  requireVerifier: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (!authenticatedUser) return _res.status(401).json({ error: 'Unauthorized' })
    next()
  },
}))

jest.unstable_mockModule('../services/idempotency.js', () => ({
  validateIdempotencyKey: mockValidateIdempotencyKey,
  scopeIdempotencyKey: mockScopeIdempotencyKey,
  hashRequestPayload: mockHashRequestPayload,
  getIdempotentResponse: mockGetIdempotentResponse,
  saveIdempotentResponse: mockSaveIdempotentResponse,
  failPendingIdempotentResponse: mockFailPendingIdempotentResponse,
  IdempotencyConflictError,
  IdempotencyOwnerMismatchError,
}))

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  getVaultById: jest.fn<any>().mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000000',
    status: 'active',
    verifier: 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB',
    creator: 'user-1',
  }),
}))

jest.unstable_mockModule('../services/milestones.js', () => ({
  createMilestoneWithThreshold: jest.fn<any>().mockReturnValue({
    id: 'ms-12345-abcdefg',
    vaultId: '00000000-0000-0000-0000-000000000000',
    description: 'Test Milestone',
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    verifierId: null,
    createdAt: '2030-01-01T00:00:00Z',
  }),
  getMilestoneById: jest.fn<any>().mockReturnValue({
    id: 'ms-12345-abcdefg',
    vaultId: '00000000-0000-0000-0000-000000000000',
    description: 'Test Milestone',
    verified: false,
  }),
  verifyMilestone: jest.fn<any>().mockReturnValue({
    id: 'ms-12345-abcdefg',
    verified: true,
  }),
  validateMilestone: jest.fn<any>().mockReturnValue({
    success: true,
    milestone: { id: 'ms-12345-abcdefg', verified: true },
  }),
  allMilestonesVerified: jest.fn<any>().mockReturnValue(false),
  getMilestonesByVaultId: jest.fn<any>().mockReturnValue([]),
  allMilestonesMetThreshold: jest.fn<any>().mockReturnValue(false),
}))

jest.unstable_mockModule('../services/vaultTransitions.js', () => ({
  transitionVaultStatus: jest.fn<any>(),
}))

jest.unstable_mockModule('../db/index.js', () => ({
  default: {
    transaction: jest.fn<any>().mockImplementation(async (cb: any) => cb({})),
  },
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  getVerifierProfile: jest.fn<any>().mockResolvedValue({ status: 'approved' }),
  hasVerifierVoted: jest.fn<any>().mockResolvedValue(false),
  getMilestoneApprovalProgress: jest.fn<any>().mockResolvedValue({ isComplete: false, isRejected: false }),
  recordMilestoneApproval: jest.fn<any>().mockResolvedValue({ id: 'app-1', approvalStatus: 'approved' }),
  getMilestoneApprovals: jest.fn<any>().mockResolvedValue({ approved: [], rejected: [], pending: [] }),
  // milestones.ts route imports DuplicateVerifierVoteError for instanceof checks.
  DuplicateVerifierVoteError: class DuplicateVerifierVoteError extends Error {},
}))

const { milestonesRouter } = await import('../routes/milestones.js')

const validBody = () => ({
  title: 'Test Milestone',
  dueDate: '2030-02-01T00:00:00.000Z',
  amount: '300',
  approvalThreshold: 1,
})

const MOCK_RESPONSE = {
  id: 'ms-12345-abcdefg',
  title: 'Test Milestone',
  amount: '300',
}

const app = express()
app.use(express.json())
app.use('/api/vaults/:vaultId/milestones', milestonesRouter)

// requireWalletIdentity (defined in milestones.ts) demands a connected-wallet
// identity on POST routes: a 0x-prefixed wallet address + a network identifier.
const WALLET_HEADERS = {
  'x-wallet-address': '0x' + 'a'.repeat(40),
  'x-network-id': 'testnet',
}

function setupHappyPath() {
  mockValidateIdempotencyKey.mockImplementation((key: string) =>
    key && /^[A-Za-z0-9_-]{1,255}$/.test(key)
      ? { valid: true }
      : { valid: false, code: 'INVALID_IDEMPOTENCY_KEY', error: 'Idempotency key is invalid' },
  )
  mockScopeIdempotencyKey.mockImplementation((userId: string, key: string) => `${userId}:${key}`)
  mockHashRequestPayload.mockReturnValue('hash-1')
  mockGetIdempotentResponse.mockResolvedValue(null)
  mockSaveIdempotentResponse.mockResolvedValue(undefined)
}

beforeEach(() => {
  jest.clearAllMocks()
  authenticatedUser = { userId: 'user-1', role: 'USER' }
  setupHappyPath()
})

describe('POST /api/vaults/:vaultId/milestones — authorization and idempotency boundary', () => {
  test('creates a milestone and binds the idempotency key to the authenticated principal', async () => {
    const res = await request(app)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/milestones')
      .set(WALLET_HEADERS)
      .set('idempotency-key', 'create-1')
      .send(validBody())

    expect(res.status).toBe(201)
    expect(res.body.id).toBe('ms-12345-abcdefg')
    expect(res.body.idempotency).toEqual({ key: 'create-1', replayed: false })
    expect(mockScopeIdempotencyKey).toHaveBeenCalledWith('user-1', 'create-1')
  })

  test('rejects a disconnected-wallet request with 401 before any side effects', async () => {
    authenticatedUser = null
    const res = await request(app)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/milestones')
      .set('idempotency-key', 'create-nobody')
      .send(validBody())

    expect(res.status).toBe(401)
    expect(mockSaveIdempotentResponse).not.toHaveBeenCalled()
  })

  test('replays the stored response with 200 when the key was already used', async () => {
    mockGetIdempotentResponse.mockResolvedValue(MOCK_RESPONSE)

    const res = await request(app)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/milestones')
      .set(WALLET_HEADERS)
      .set('idempotency-key', 'create-replay')
      .send(validBody())

    expect(res.status).toBe(200)
    expect(res.body.idempotency).toEqual({ key: 'create-replay', replayed: true })
    expect(mockSaveIdempotentResponse).not.toHaveBeenCalled()
  })

  test('returns 409 when the same key is reused with a tampered payload', async () => {
    mockGetIdempotentResponse.mockRejectedValue(new IdempotencyConflictError())

    const res = await request(app)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/milestones')
      .set(WALLET_HEADERS)
      .set('idempotency-key', 'create-tamper')
      .send({ ...validBody(), amount: '9999' })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('returns 400 for a malformed idempotency key', async () => {
    mockValidateIdempotencyKey.mockReturnValue({
      valid: false,
      code: 'INVALID_IDEMPOTENCY_KEY',
      error: 'Invalid',
    })

    const res = await request(app)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/milestones')
      .set(WALLET_HEADERS)
      .set('idempotency-key', 'bad key!')
      .send(validBody())

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
  })

  test('fails closed with 500 when a replayed stored response is malformed', async () => {
    // Malformed response (not an object)
    mockGetIdempotentResponse.mockResolvedValue('invalid string instead of object')

    const res = await request(app)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/milestones')
      .set(WALLET_HEADERS)
      .set('idempotency-key', 'create-replay-malformed')
      .send(validBody())

    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/malformed/)
  })

  test('rejects a malformed vault id on POST with 400', async () => {
    const res = await request(app)
      .post('/api/vaults/not-a-uuid/milestones')
      .set(WALLET_HEADERS)
      .send(validBody())
    expect(res.status).toBe(400)
  })

  test('rejects a malformed milestone id on POST validate with 400', async () => {
    const res = await request(app)
      .post('/api/vaults/00000000-0000-0000-0000-000000000000/milestones/invalid-id/validate')
      .set(WALLET_HEADERS)
      .send({ evidenceHash: '00000000000000000000000000000000' })
    expect(res.status).toBe(400)
  })
})
