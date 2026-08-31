/**
 * Route-level tests for the vault-creation idempotency + authorization
 * boundary (issue #1520).
 *
 * Covers the hostile-input scenarios the reservation layer must survive:
 * replay, tampering, wrong-network, disconnected-wallet, malformed stored
 * responses, spoofed identity headers, and malformed route parameters.
 *
 * The idempotency coordinator, store, payload builder, audit log, and
 * analytics are mocked; the express router, auth middleware boundary, and
 * real zod schema (including the onChain network validation) run for real.
 */
import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

// The mocked authenticate middleware consults this; set to null to simulate a
// disconnected-wallet request that reaches the handler without a principal.
let authenticatedUser: { userId: string; role: string } | null = { userId: 'user-1', role: 'USER' }

const mockCreateVaultIdempotently = jest.fn<any>()
const mockCreateVaultWithMilestones = jest.fn<any>()
const mockBuildVaultCreationPayload = jest.fn<any>()
const mockCreateAuditLog = jest.fn<any>()
const mockUpdateAnalyticsSummary = jest.fn<any>()
const mockGetVaultById = jest.fn<any>()
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
}))

jest.unstable_mockModule('../middleware/apiKeyAuth.js', () => ({
  requireScopes: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

jest.unstable_mockModule('../services/idempotency.js', () => ({
  validateIdempotencyKey: mockValidateIdempotencyKey,
  scopeIdempotencyKey: mockScopeIdempotencyKey,
  hashRequestPayload: mockHashRequestPayload,
}))

jest.unstable_mockModule('../services/vaultCreationIdempotency.js', () => ({
  createVaultIdempotently: mockCreateVaultIdempotently,
  VaultCreationIdempotencyConflictError: class VaultCreationIdempotencyConflictError extends Error {
    readonly code = 'IDEMPOTENCY_CONFLICT'
    constructor(message = 'Idempotency key was already used with a different request') {
      super(message)
      this.name = 'VaultCreationIdempotencyConflictError'
    }
  },
  VaultCreationInProgressError: class VaultCreationInProgressError extends Error {
    readonly code = 'IDEMPOTENCY_IN_PROGRESS'
    constructor(message = 'A vault creation with this idempotency key is still in progress') {
      super(message)
      this.name = 'VaultCreationInProgressError'
    }
  },
  VaultCreationOwnerError: class VaultCreationOwnerError extends Error {
    readonly code = 'IDEMPOTENCY_OWNER_MISMATCH'
    constructor(message = 'Idempotency key belongs to a different owner') {
      super(message)
      this.name = 'VaultCreationOwnerError'
    }
  },
}))

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  createVaultWithMilestones: mockCreateVaultWithMilestones,
  getVaultById: mockGetVaultById,
  listVaults: jest.fn<any>(),
  cancelVaultById: jest.fn<any>(),
  updateVaultById: jest.fn<any>(),
  getVaultRevisionById: jest.fn<any>(),
  getVaultETag: jest.fn<any>(),
}))

jest.unstable_mockModule('../services/soroban.js', () => ({
  buildVaultCreationPayload: mockBuildVaultCreationPayload,
}))

jest.unstable_mockModule('../services/vault.service.js', () => ({
  VaultService: {
    getVaultsByUser: jest.fn<any>().mockResolvedValue([]),
    getVaultById: jest.fn<any>(),
    updateVaultStatus: jest.fn<any>(),
    getVaultTimeline: jest.fn<any>(),
  },
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../services/analytics.service.js', () => ({
  updateAnalyticsSummary: mockUpdateAnalyticsSummary,
}))

const { vaultsRouter } = await import('../routes/vaults.js')

// Valid Stellar addresses (real checksums via StrKey).
const G = 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB'
const G2 = 'GAT7KQ5MRI34Y5M52Z2GZGQMOAZXUEGPV3U5SERQZQE4HHYBE4SH3X2N'
const G3 = 'GBWUD4PUYATGWVDMNN3VRQZL45GSY2ZG5QCWNM4AUGYXDCFKMQUF33JU'

const validBody = (overrides: Record<string, unknown> = {}) => ({
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: G,
  destinations: { success: G2, failure: G3 },
  milestones: [
    { title: 'Kickoff', dueDate: '2030-02-01T00:00:00.000Z', amount: '300' },
    { title: 'Final review', dueDate: '2030-05-01T00:00:00.000Z', amount: '700' },
  ],
  creator: G,
  ...overrides,
})

const MOCK_VAULT = {
  id: 'vault-1',
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: G,
  successDestination: G2,
  failureDestination: G3,
  creator: G,
  status: 'draft',
  createdAt: '2026-01-01T00:00:00.000Z',
  milestones: [],
  lateCheckInWindowSecs: 0,
}

const MOCK_ONCHAIN = {
  mode: 'build',
  payload: {
    contractId: `C${'A'.repeat(55)}`,
    networkPassphrase: 'Test SDF Network ; September 2015',
    sourceAccount: G,
    method: 'create_vault',
    args: {},
  },
  submission: { attempted: false, status: 'not_requested' },
}

const MOCK_RESPONSE = {
  vault: MOCK_VAULT,
  onChain: MOCK_ONCHAIN,
  idempotency: { key: 'key-1', replayed: false },
}

const app = express()
app.use(express.json())
app.use('/api/vaults', vaultsRouter)

function setupHappyPath() {
  mockCreateVaultWithMilestones.mockResolvedValue({ vault: MOCK_VAULT })
  mockBuildVaultCreationPayload.mockResolvedValue(MOCK_ONCHAIN)
  mockCreateAuditLog.mockResolvedValue({ id: 'audit-1' })
  mockUpdateAnalyticsSummary.mockResolvedValue(undefined)
  mockValidateIdempotencyKey.mockImplementation((key: string) =>
    key && /^[A-Za-z0-9_-]{1,255}$/.test(key)
      ? { valid: true }
      : { valid: false, code: 'INVALID_IDEMPOTENCY_KEY', error: 'Idempotency key is invalid' },
  )
  mockScopeIdempotencyKey.mockImplementation((userId: string, key: string) => `${userId}:${key}`)
  mockHashRequestPayload.mockReturnValue('hash-1')
  mockCreateVaultIdempotently.mockImplementation(async (_options: unknown, actions: any) => {
    const vault = await actions.createVault(null)
    const response = await actions.buildResponse(vault)
    return { vault, response, replayed: false }
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  authenticatedUser = { userId: 'user-1', role: 'USER' }
  setupHappyPath()
})

beforeAll(() => {
  process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
  // Keep isMemoRequired from making real network calls: point Horizon at a
  // non-routable address so lookups fail fast and are treated as memo-free.
  process.env.HORIZON_URL = 'http://127.0.0.1:9'
})

afterAll(() => {
  delete process.env.SOROBAN_NETWORK_PASSPHRASE
  delete process.env.HORIZON_URL
})

describe('POST /api/vaults — authorization boundary', () => {
  test('creates a vault and binds the idempotency key to the authenticated principal', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-1')
      .send(validBody())

    expect(res.status).toBe(201)
    expect(res.body.vault.id).toBe('vault-1')
    expect(res.body.idempotency).toEqual({ key: 'create-1', replayed: false })
    expect(mockScopeIdempotencyKey).toHaveBeenCalledWith('user-1', 'create-1')
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actor_user_id: 'user-1', action: 'vault.created' }),
    )
  })

  test('ignores spoofed x-user-id headers and body creator when recording the actor', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-spoof')
      .set('x-user-id', 'attacker-999')
      .send(validBody())

    expect(res.status).toBe(201)
    // The audit actor must be the verified principal, never client state.
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actor_user_id: 'user-1' }),
    )
    expect(mockCreateAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ actor_user_id: 'attacker-999' }),
    )
    expect(mockScopeIdempotencyKey).toHaveBeenCalledWith('user-1', 'create-spoof')
  })

  test('rejects a disconnected-wallet request with 401 before any side effects', async () => {
    authenticatedUser = null
    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-nobody')
      .send(validBody())

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
    expect(mockCreateVaultWithMilestones).not.toHaveBeenCalled()
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })
})

describe('POST /api/vaults — idempotency replay and tampering', () => {
  test('replays the stored response with 200 when the key was already used', async () => {
    mockCreateVaultIdempotently.mockResolvedValue({
      vault: { id: 'vault-1' },
      response: MOCK_RESPONSE,
      replayed: true,
    })

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-replay')
      .send(validBody())

    expect(res.status).toBe(200)
    expect(res.body.vault.id).toBe('vault-1')
    expect(res.body.idempotency).toEqual({ key: 'create-replay', replayed: true })
    expect(mockCreateVaultWithMilestones).not.toHaveBeenCalled()
  })

  test('returns 409 when the same key is reused with a tampered payload', async () => {
    const { VaultCreationIdempotencyConflictError } = await import('../services/vaultCreationIdempotency.js')
    mockCreateVaultIdempotently.mockRejectedValue(new VaultCreationIdempotencyConflictError())

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-tamper')
      .send(validBody({ amount: '9999' }))

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('returns 409 with owner mismatch when another principal replays the key', async () => {
    const { VaultCreationOwnerError } = await import('../services/vaultCreationIdempotency.js')
    mockCreateVaultIdempotently.mockRejectedValue(new VaultCreationOwnerError())

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-owner')
      .send(validBody())

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_OWNER_MISMATCH')
  })

  test('returns a retryable 409 while a first request still holds the reservation', async () => {
    const { VaultCreationInProgressError } = await import('../services/vaultCreationIdempotency.js')
    mockCreateVaultIdempotently.mockRejectedValue(new VaultCreationInProgressError())

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-inflight')
      .send(validBody())

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS')
    expect(res.body.error.retryable).toBe(true)
  })

  test('returns 400 for a malformed idempotency key before any side effects', async () => {
    mockValidateIdempotencyKey.mockReturnValue({
      valid: false,
      code: 'INVALID_IDEMPOTENCY_KEY',
      error: 'Idempotency key must be 1–255 characters and contain only letters, digits, hyphens, and underscores.',
    })

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'bad key!')
      .send(validBody())

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY')
    expect(mockCreateVaultWithMilestones).not.toHaveBeenCalled()
  })
})

describe('POST /api/vaults — wrong-network boundary', () => {
  test('rejects an onChain network passphrase that differs from the configured network', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-network')
      .send(
        validBody({
          onChain: { networkPassphrase: 'Public Global Stellar Network ; September 2015' },
        }),
      )

    expect(res.status).toBe(400)
    const issue = (res.body.details ?? []).find((f: { path: string }) => f.path === 'onChain.networkPassphrase')
    expect(issue).toBeDefined()
    expect(mockCreateVaultWithMilestones).not.toHaveBeenCalled()
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  test('accepts an onChain block pinned to the configured network', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-network-ok')
      .send(validBody({ onChain: { mode: 'build' } }))

    expect(res.status).toBe(201)
  })
})

describe('POST /api/vaults — malformed-response boundary', () => {
  test('fails closed with 500 when the built response violates the response contract', async () => {
    mockCreateVaultIdempotently.mockResolvedValue({
      vault: { id: 'vault-1' },
      response: { vault: null },
      replayed: false,
    })

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-malformed')
      .send(validBody())

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Failed to create vault.')
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  test('fails closed with 500 when a replayed stored response is malformed', async () => {
    mockCreateVaultIdempotently.mockResolvedValue({
      vault: { id: 'vault-1' },
      response: { vault: { id: '' }, onChain: MOCK_ONCHAIN },
      replayed: true,
    })

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'create-replay-malformed')
      .send(validBody())

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Failed to create vault.')
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })
})

describe('vault route-parameter boundary', () => {
  test('rejects a malformed vault id on GET /:id with 400', async () => {
    const res = await request(app).get('/api/vaults/not-a-uuid')
    expect(res.status).toBe(400)
    expect(mockGetVaultById).not.toHaveBeenCalled()
  })

  test('rejects a malformed vault id on PATCH /:id with 400', async () => {
    const res = await request(app).patch('/api/vaults/not-a-uuid').set('x-vault-revision', '123').send({})
    expect(res.status).toBe(400)
  })

  test('rejects a malformed vault id on POST /:id/cancel with 400', async () => {
    const res = await request(app).post('/api/vaults/not-a-uuid/cancel')
    expect(res.status).toBe(400)
  })

  test('passes valid UUID vault ids through to the store', async () => {
    mockGetVaultById.mockResolvedValue(null)
    const res = await request(app).get('/api/vaults/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
    expect(mockGetVaultById).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000000')
  })

  test('rejects a malformed wallet address on GET /user/:address with 400', async () => {
    const res = await request(app).get('/api/vaults/user/not-a-stellar-address')
    expect(res.status).toBe(400)
  })

  test('accepts a valid wallet address on GET /user/:address', async () => {
    const res = await request(app).get(`/api/vaults/user/${G}`)
    expect(res.status).toBe(200)
  })
})
