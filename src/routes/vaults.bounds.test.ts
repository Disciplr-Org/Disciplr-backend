/**
 * Tests for:
 * 1. Pagination bound enforcement on GET /api/vaults (pageSize 1–100, page >= 1)
 * 2. Telemetry span attributes on POST /api/vaults (via InMemoryExporter)
 *
 * Refs #1520
 */
import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'
import { InMemoryExporter, _setTracerForTesting, _resetTracingForTesting } from '../observability/tracing.js'

// ─── Auth / service mocks ─────────────────────────────────────────────────────

let authenticatedUser: { userId: string; role: string } | null = { userId: 'user-1', role: 'USER' }

const mockCreateVaultIdempotently = jest.fn<any>()
const mockCreateVaultWithMilestones = jest.fn<any>()
const mockBuildVaultCreationPayload = jest.fn<any>()
const mockListVaults = jest.fn<any>()
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
    constructor(m = 'conflict') { super(m); this.name = 'VaultCreationIdempotencyConflictError' }
  },
  VaultCreationInProgressError: class VaultCreationInProgressError extends Error {
    readonly code = 'IDEMPOTENCY_IN_PROGRESS'
    constructor(m = 'in progress') { super(m); this.name = 'VaultCreationInProgressError' }
  },
  VaultCreationOwnerError: class VaultCreationOwnerError extends Error {
    readonly code = 'IDEMPOTENCY_OWNER_MISMATCH'
    constructor(m = 'owner mismatch') { super(m); this.name = 'VaultCreationOwnerError' }
  },
}))

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  createVaultWithMilestones: mockCreateVaultWithMilestones,
  listVaults: mockListVaults,
  getVaultById: jest.fn<any>().mockResolvedValue(null),
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
  createAuditLog: jest.fn<any>(),
}))

jest.unstable_mockModule('../services/analytics.service.js', () => ({
  updateAnalyticsSummary: jest.fn<any>(),
}))

const { vaultsRouter } = await import('../routes/vaults.js')

// ─── Valid request fixtures ───────────────────────────────────────────────────

const G  = 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB'
const G2 = 'GAT7KQ5MRI34Y5M52Z2GZGQMOAZXUEGPV3U5SERQZQE4HHYBE4SH3X2N'
const G3 = 'GBWUD4PUYATGWVDMNN3VRQZL45GSY2ZG5QCWNM4AUGYXDCFKMQUF33JU'

const validBody = (overrides: Record<string, unknown> = {}) => ({
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: G,
  destinations: { success: G2, failure: G3 },
  milestones: [
    { title: 'Kickoff', dueDate: '2030-02-01T00:00:00.000Z', amount: '500' },
    { title: 'Finish', dueDate: '2030-05-01T00:00:00.000Z', amount: '500' },
  ],
  creator: G,
  ...overrides,
})

const MOCK_VAULT = {
  id: 'vault-t1',
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

const app = express()
app.use(express.json())
app.use('/api/vaults', vaultsRouter)

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
  process.env.HORIZON_URL = 'http://127.0.0.1:9'
})

afterAll(() => {
  delete process.env.SOROBAN_NETWORK_PASSPHRASE
  delete process.env.HORIZON_URL
  _resetTracingForTesting()
})

beforeEach(() => {
  jest.clearAllMocks()
  authenticatedUser = { userId: 'user-1', role: 'USER' }

  mockValidateIdempotencyKey.mockImplementation((key: string) =>
    /^[A-Za-z0-9_-]{1,255}$/.test(key)
      ? { valid: true }
      : { valid: false, code: 'INVALID_IDEMPOTENCY_KEY', error: 'invalid key' },
  )
  mockScopeIdempotencyKey.mockImplementation((uid: string, key: string) => `${uid}:${key}`)
  mockHashRequestPayload.mockReturnValue('hash-1')

  mockCreateVaultWithMilestones.mockResolvedValue({ vault: MOCK_VAULT })
  mockBuildVaultCreationPayload.mockResolvedValue(MOCK_ONCHAIN)
  mockListVaults.mockResolvedValue([])

  mockCreateVaultIdempotently.mockImplementation(async (_opts: unknown, actions: any) => {
    const vault = await actions.createVault(null)
    const response = await actions.buildResponse(vault)
    return { vault, response, replayed: false }
  })
})

// ─── GET /api/vaults — pagination bound enforcement ───────────────────────────

describe('GET /api/vaults — pagination bounds', () => {
  test('accepts pageSize=1 (minimum)', async () => {
    const res = await request(app).get('/api/vaults?pageSize=1')
    expect(res.status).not.toBe(400)
  })

  test('accepts pageSize=100 (maximum)', async () => {
    const res = await request(app).get('/api/vaults?pageSize=100')
    expect(res.status).not.toBe(400)
  })

  test('rejects pageSize=0 with 400', async () => {
    const res = await request(app).get('/api/vaults?pageSize=0')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockListVaults).not.toHaveBeenCalled()
  })

  test('rejects pageSize=101 with 400', async () => {
    const res = await request(app).get('/api/vaults?pageSize=101')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockListVaults).not.toHaveBeenCalled()
  })

  test('rejects non-integer pageSize with 400', async () => {
    const res = await request(app).get('/api/vaults?pageSize=1.5')
    expect(res.status).toBe(400)
    expect(mockListVaults).not.toHaveBeenCalled()
  })

  test('rejects page=0 with 400', async () => {
    const res = await request(app).get('/api/vaults?page=0')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(mockListVaults).not.toHaveBeenCalled()
  })

  test('rejects page=-1 with 400', async () => {
    const res = await request(app).get('/api/vaults?page=-1')
    expect(res.status).toBe(400)
    expect(mockListVaults).not.toHaveBeenCalled()
  })

  test('accepts page=1 (first page)', async () => {
    const res = await request(app).get('/api/vaults?page=1')
    expect(res.status).not.toBe(400)
    expect(mockListVaults).toHaveBeenCalled()
  })

  test('accepts omitted page and pageSize (defaults)', async () => {
    const res = await request(app).get('/api/vaults')
    expect(res.status).not.toBe(400)
    expect(mockListVaults).toHaveBeenCalled()
  })
})

// ─── POST /api/vaults — telemetry span attributes ─────────────────────────────

describe('POST /api/vaults — telemetry spans', () => {
  let exporter: InstanceType<typeof InMemoryExporter>

  beforeEach(async () => {
    const { TracerFactory } = await import('../observability/tracing.js').then(async m => {
      // Build a real tracer backed by InMemoryExporter so spans are captured
      const exp = new m.InMemoryExporter()
      exporter = exp
      // Reach into the module to install a test tracer without an OTLP endpoint
      const { _setTracerForTesting } = m
      // Create a tracer that writes to our exporter via the public factory
      // The tracing module exposes _setTracerForTesting for exactly this purpose
      _setTracerForTesting({
        startSpan: (name: string, _parent: any, attrs?: any) => {
          const span = exp.spans.length  // track index
          const s = {
            name,
            attributes: { ...(attrs ?? {}) } as Record<string, any>,
            status: { code: 'OK' as const },
            events: [] as any[],
            traceId: 'test',
            spanId: String(Date.now()),
            startTime: Date.now(),
            setAttribute(k: string, v: any) { s.attributes[k] = v },
            setStatus(st: any) { s.status = st },
            addEvent() {},
            recordException() {},
            end() { exp.spans.push(s as any) },
          }
          return s
        },
        withSpan: async (_name: string, fn: (s: any) => any) => fn({}),
      })
      return { TracerFactory: null }
    })
  })

  afterEach(() => {
    _resetTracingForTesting()
  })

  test('emits a span with OK status, vault_id and replayed=false on success', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'span-test-1')
      .send(validBody())

    expect(res.status).toBe(201)

    const span = exporter.spans.find(s => s.name === 'vault.create')
    expect(span).toBeDefined()
    expect(span!.status.code).toBe('OK')
    expect(span!.attributes['vault.create.vault_id']).toBe('vault-t1')
    expect(span!.attributes['vault.create.replayed']).toBe(false)
    expect(span!.attributes['vault.create.milestone_count']).toBe(2)
    expect(typeof span!.attributes['vault.create.latency_ms']).toBe('number')
  })

  test('emits a span with ERROR status and error_code=UNAUTHORIZED on missing auth', async () => {
    authenticatedUser = null

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'span-test-unauth')
      .send(validBody())

    expect(res.status).toBe(401)

    const span = exporter.spans.find(s => s.name === 'vault.create')
    expect(span).toBeDefined()
    expect(span!.status.code).toBe('ERROR')
    expect(span!.attributes['vault.create.error_code']).toBe('UNAUTHORIZED')
  })

  test('emits a span with ERROR status and error_code=IDEMPOTENCY_CONFLICT on conflict', async () => {
    const { VaultCreationIdempotencyConflictError } = await import('../services/vaultCreationIdempotency.js')
    mockCreateVaultIdempotently.mockRejectedValue(new VaultCreationIdempotencyConflictError())

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'span-test-conflict')
      .send(validBody())

    expect(res.status).toBe(409)

    const span = exporter.spans.find(s => s.name === 'vault.create')
    expect(span).toBeDefined()
    expect(span!.status.code).toBe('ERROR')
    expect(span!.attributes['vault.create.error_code']).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('emits a span with retryable=true on in-progress conflict', async () => {
    const { VaultCreationInProgressError } = await import('../services/vaultCreationIdempotency.js')
    mockCreateVaultIdempotently.mockRejectedValue(new VaultCreationInProgressError())

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'span-test-inflight')
      .send(validBody())

    expect(res.status).toBe(409)

    const span = exporter.spans.find(s => s.name === 'vault.create')
    expect(span).toBeDefined()
    expect(span!.attributes['vault.create.retryable']).toBe(true)
  })

  test('emits a span with replayed=true on idempotency replay', async () => {
    const replayResponse = {
      vault: MOCK_VAULT,
      onChain: MOCK_ONCHAIN,
      idempotency: { key: 'span-test-replay', replayed: true },
    }
    mockCreateVaultIdempotently.mockResolvedValue({
      vault: MOCK_VAULT,
      response: replayResponse,
      replayed: true,
    })

    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'span-test-replay')
      .send(validBody())

    expect(res.status).toBe(200)

    const span = exporter.spans.find(s => s.name === 'vault.create')
    expect(span).toBeDefined()
    expect(span!.attributes['vault.create.replayed']).toBe(true)
  })

  test('never records idempotency key value in span attributes', async () => {
    await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'secret-key-value')
      .send(validBody())

    const span = exporter.spans.find(s => s.name === 'vault.create')
    expect(span).toBeDefined()
    const attrValues = Object.values(span!.attributes)
    expect(attrValues).not.toContain('secret-key-value')
    // Also assert user id is not recorded (PII)
    expect(attrValues).not.toContain('user-1')
  })

  test('emits a span with error_code=VALIDATION_ERROR on invalid body', async () => {
    const res = await request(app)
      .post('/api/vaults')
      .set('idempotency-key', 'span-validation')
      .send({ amount: 'not-a-number' })

    expect(res.status).toBe(400)

    const span = exporter.spans.find(s => s.name === 'vault.create')
    expect(span).toBeDefined()
    expect(span!.attributes['vault.create.error_code']).toBe('VALIDATION_ERROR')
  })
})
