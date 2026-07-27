import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals'
import request from 'supertest'
import { app } from '../app'
import { createAuditLog } from '../lib/audit-logs'
import { generateAccessToken } from '../lib/auth-utils'
import { UserRole } from '../types/user'
import {
  clearConfirmationTokens,
  issueConfirmationToken,
  approveConfirmationToken,
  validateConfirmationToken,
  isDualControlRequired,
  VALID_DESTRUCTIVE_ACTIONS,
} from '../middleware/confirmationToken'

// ── Service mocks ─────────────────────────────────────────────────────────────
// Factory functions must be self-contained (no external variable refs) due to hoisting.

jest.mock('../lib/audit-logs', () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: 'audit-123', created_at: '2026-06-28T00:00:00.000Z' } as never),
  getAuditLogById: jest.fn().mockResolvedValue(null as never),
  listAuditLogs: jest.fn().mockResolvedValue([] as never),
  verifyAuditLogChain: jest.fn().mockResolvedValue({ verified: true } as never),
  exportAuditLogsForOrganization: jest.fn().mockResolvedValue({} as never),
}))

jest.mock('../services/session', () => ({
  recordSession: jest.fn().mockResolvedValue(undefined as never),
  validateSession: jest.fn().mockResolvedValue(true as never),
  forceRevokeUserSessions: jest.fn().mockResolvedValue(undefined as never),
  revokeAllUserSessions: jest.fn().mockResolvedValue(undefined as never),
}))

jest.mock('../lib/prismaScope', () => ({
  getPrisma: jest.fn(() => ({
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'target-user-id', role: UserRole.USER } as never),
    },
  })),
}))

jest.mock('../middleware/stepUp', () => ({
  requireStepUp: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}))

jest.mock('../services/user.service', () => ({
  userService: {
    getUserById: jest.fn().mockImplementation((id: string) => {
      if (id === 'admin-1') return null // can't delete self
      return Promise.resolve({
        id,
        email: 'victim@example.com',
        role: UserRole.USER,
        deletedAt: null,
      })
    }),
    softDeleteUser: jest.fn().mockResolvedValue({
      success: true,
      deletionType: 'soft',
      deletedAt: new Date().toISOString(),
    } as never),
    hardDeleteUser: jest.fn().mockResolvedValue({
      success: true,
      deletionType: 'hard',
      deletedAt: new Date().toISOString(),
    } as never),
    listUsers: jest.fn().mockResolvedValue({ users: [], total: 0 } as never),
    updateUserRole: jest.fn().mockResolvedValue({} as never),
    updateUserStatus: jest.fn().mockResolvedValue({} as never),
    restoreUser: jest.fn().mockResolvedValue({} as never),
  },
}))

jest.mock('../db/knex', () => {
  // Must be self-contained: jest.mock factories are hoisted above const declarations.
  const makeChain = (resolveWith: unknown) => ({
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    max: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(resolveWith as never),
    insert: jest.fn().mockResolvedValue([1] as never),
    returning: jest.fn().mockResolvedValue([{ id: 'audit-123' }] as never),
  })

  const db = jest.fn().mockImplementation((table: string) => {
    if (table === 'processed_events') return makeChain({ max_ledger: 90 })
    if (table === 'listener_state') return makeChain(null)
    if (table === 'failed_events') return makeChain(null)
    if (table === 'audit_logs') return makeChain({ total: '0' })
    return makeChain(null)
  }) as jest.MockedFunction<any> & { transaction: jest.MockedFunction<any> }

  db.transaction = jest.fn().mockImplementation(async (fn: (trx: unknown) => unknown) =>
    fn(db),
  ) as jest.MockedFunction<any>

  return { db }
})

jest.mock('../services/checkpointStore', () => ({
  CheckpointStore: jest.fn().mockImplementation(() => ({
    getAllCheckpoints: jest.fn().mockResolvedValue([
      {
        contractAddress: 'CCONTRACT1',
        lastLedger: 100,
        lastPagingToken: null,
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    ] as never),
    getCheckpoint: jest.fn().mockResolvedValue({
      contractAddress: 'CCONTRACT1',
      lastLedger: 100,
      lastPagingToken: null,
      updatedAt: new Date(),
      createdAt: new Date(),
    } as never),
    resetCheckpoint: jest.fn().mockResolvedValue(undefined as never),
  })),
}))

jest.mock('../services/evidenceReindex', () => ({
  runReindexBatches: jest.fn().mockResolvedValue({
    batches: 1,
    reindexed: 5,
    skippedUpToDate: 2,
    done: true,
    cursor: null,
  } as never),
  EMBEDDING_REINDEX_JOB_NAME: 'milestone_embeddings_reindex',
}))

jest.mock('../services/embeddingProvider', () => ({
  createEmbeddingProvider: jest.fn().mockReturnValue({}),
  detectEmbeddingDrift: jest.fn().mockResolvedValue({ staleCount: 0, totalEmbeddings: 10, currentModelVersion: 'v1' } as never),
  CURRENT_EMBEDDING_MODEL_VERSION: 'v1',
}))

jest.mock('../repositories/milestoneRepository', () => ({
  MilestoneRepository: jest.fn().mockImplementation(() => ({})),
}))

jest.mock('../services/backfillCursorStore', () => ({
  BackfillCursorStore: jest.fn().mockImplementation(() => ({
    resetCursor: jest.fn().mockResolvedValue(undefined as never),
    getCursor: jest.fn().mockResolvedValue(null as never),
    setCursor: jest.fn().mockResolvedValue(undefined as never),
  })),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeAdminToken = (userId = 'admin-1') =>
  generateAccessToken({ userId, role: UserRole.ADMIN })

const nonAdminToken = () =>
  generateAccessToken({ userId: 'user-1', role: UserRole.USER })

const mockedCreateAuditLog = createAuditLog as jest.MockedFunction<typeof createAuditLog>

// ── Unit tests: token lifecycle ───────────────────────────────────────────────

describe('confirmationToken: issueConfirmationToken', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-28T00:00:00.000Z'))
    clearConfirmationTokens()
  })
  afterEach(() => jest.useRealTimers())

  test('issues a token with correct fields', () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset', 'CCONTRACT1')
    expect(entry.tokenId).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry.userId).toBe('admin-1')
    expect(entry.action).toBe('horizon.cursor.reset')
    expect(entry.scope).toBe('CCONTRACT1')
    expect(entry.used).toBe(false)
    expect(entry.dualControlRequired).toBe(false)
    expect(entry.expiresAt).toBe(Date.now() + 5 * 60 * 1000)
  })

  test('dual-control action gets longer TTL', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    expect(entry.dualControlRequired).toBe(true)
    expect(entry.expiresAt).toBe(Date.now() + 15 * 60 * 1000)
  })

  test('each issued token has a unique tokenId', () => {
    const a = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    const b = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    expect(a.tokenId).not.toBe(b.tokenId)
  })
})

describe('confirmationToken: validateConfirmationToken', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-28T00:00:00.000Z'))
    clearConfirmationTokens()
  })
  afterEach(() => jest.useRealTimers())

  test('valid token is consumed and returned', () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    const result = validateConfirmationToken(entry.tokenId, 'admin-1', 'horizon.cursor.reset')
    expect(result).not.toBeNull()
    expect(result!.tokenId).toBe(entry.tokenId)
  })

  test('missing token returns null', () => {
    expect(validateConfirmationToken('no-such-token', 'admin-1', 'horizon.cursor.reset')).toBeNull()
  })

  test('expired token is rejected', () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    jest.setSystemTime(new Date('2026-06-28T00:05:01.000Z'))
    expect(validateConfirmationToken(entry.tokenId, 'admin-1', 'horizon.cursor.reset')).toBeNull()
  })

  test('wrong-scope (action mismatch) token is rejected', () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    expect(validateConfirmationToken(entry.tokenId, 'admin-1', 'embeddings.force_resync')).toBeNull()
  })

  test('wrong-user token is rejected', () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    expect(validateConfirmationToken(entry.tokenId, 'admin-2', 'horizon.cursor.reset')).toBeNull()
  })

  test('already-used token is rejected (single-use enforcement)', () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    validateConfirmationToken(entry.tokenId, 'admin-1', 'horizon.cursor.reset')
    expect(validateConfirmationToken(entry.tokenId, 'admin-1', 'horizon.cursor.reset')).toBeNull()
  })

  test('dual-control token without approval is rejected', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    expect(validateConfirmationToken(entry.tokenId, 'admin-1', 'user.hard_delete')).toBeNull()
  })

  test('dual-control token after approval is accepted', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    approveConfirmationToken(entry.tokenId, 'admin-2')
    const result = validateConfirmationToken(entry.tokenId, 'admin-1', 'user.hard_delete')
    expect(result).not.toBeNull()
    expect(result!.approvedBy).toBe('admin-2')
  })
})

describe('confirmationToken: approveConfirmationToken', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-28T00:00:00.000Z'))
    clearConfirmationTokens()
  })
  afterEach(() => jest.useRealTimers())

  test('approves a pending dual-control token', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    const result = approveConfirmationToken(entry.tokenId, 'admin-2')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entry.approvedBy).toBe('admin-2')
      expect(result.entry.approvedAt).toBeDefined()
    }
  })

  test('rejects self-approval', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    const result = approveConfirmationToken(entry.tokenId, 'admin-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('self_approval_not_allowed')
  })

  test('rejects approval of non-dual-control action', () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    const result = approveConfirmationToken(entry.tokenId, 'admin-2')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('action_does_not_require_approval')
  })

  test('rejects approval of non-existent token', () => {
    const result = approveConfirmationToken('no-such-token', 'admin-2')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('token_not_found')
  })

  test('rejects double-approval', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    approveConfirmationToken(entry.tokenId, 'admin-2')
    const result = approveConfirmationToken(entry.tokenId, 'admin-3')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('already_approved')
  })

  test('rejects approval of expired token', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    jest.setSystemTime(new Date('2026-06-28T00:15:01.000Z'))
    const result = approveConfirmationToken(entry.tokenId, 'admin-2')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('token_expired')
  })

  test('rejects approval of already-consumed token', () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    approveConfirmationToken(entry.tokenId, 'admin-2')
    validateConfirmationToken(entry.tokenId, 'admin-1', 'user.hard_delete')
    const result = approveConfirmationToken(entry.tokenId, 'admin-3')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('token_not_found')
  })
})

describe('confirmationToken: isDualControlRequired', () => {
  test('user.hard_delete requires dual-control by default', () => {
    expect(isDualControlRequired('user.hard_delete')).toBe(true)
  })

  test('horizon.cursor.reset does not require dual-control by default', () => {
    expect(isDualControlRequired('horizon.cursor.reset')).toBe(false)
  })

  test('embeddings.force_resync does not require dual-control by default', () => {
    expect(isDualControlRequired('embeddings.force_resync')).toBe(false)
  })

  test('user.soft_delete does not require dual-control by default', () => {
    expect(isDualControlRequired('user.soft_delete')).toBe(false)
  })

  test('VALID_DESTRUCTIVE_ACTIONS contains all expected actions', () => {
    expect(VALID_DESTRUCTIVE_ACTIONS.has('horizon.cursor.reset')).toBe(true)
    expect(VALID_DESTRUCTIVE_ACTIONS.has('embeddings.force_resync')).toBe(true)
    expect(VALID_DESTRUCTIVE_ACTIONS.has('user.hard_delete')).toBe(true)
    expect(VALID_DESTRUCTIVE_ACTIONS.has('user.soft_delete')).toBe(true)
  })
})

// ── HTTP integration tests: prepare endpoint ──────────────────────────────────

describe('POST /api/admin/confirm/prepare', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearConfirmationTokens()
  })

  test('issues a confirmation token for a valid action', async () => {
    const res = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ action: 'horizon.cursor.reset', scope: 'CCONTRACT1' })
      .expect(201)

    expect(res.body.tokenId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.action).toBe('horizon.cursor.reset')
    expect(res.body.scope).toBe('CCONTRACT1')
    expect(res.body.dualControlRequired).toBe(false)
    expect(res.body.approveUrl).toBeUndefined()
    expect(res.body.expiresAt).toBeDefined()
  })

  test('dual-control action returns approveUrl', async () => {
    const res = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ action: 'user.hard_delete' })
      .expect(201)

    expect(res.body.dualControlRequired).toBe(true)
    expect(res.body.approveUrl).toMatch(/^\/api\/admin\/confirm\/approve\//)
  })

  test('rejects missing action field', async () => {
    const res = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({})
      .expect(400)

    expect(res.body.error).toMatch(/action is required/i)
    expect(res.body.validActions).toBeDefined()
  })

  test('rejects unknown action', async () => {
    const res = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ action: 'drop.database' })
      .expect(400)

    expect(res.body.error).toMatch(/Invalid action/i)
  })

  test('requires admin role', async () => {
    await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${nonAdminToken()}`)
      .send({ action: 'horizon.cursor.reset' })
      .expect(403)
  })

  test('requires authentication', async () => {
    await request(app)
      .post('/api/admin/confirm/prepare')
      .send({ action: 'horizon.cursor.reset' })
      .expect(401)
  })

  test('audit log is created with correct fields on prepare', async () => {
    await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ action: 'horizon.cursor.reset', scope: 'CCONTRACT1' })
      .expect(201)

    expect(mockedCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.destructive_action.prepared',
        actor_user_id: 'admin-1',
        target_type: 'confirmation_token',
        metadata: expect.objectContaining({
          destructive_action: 'horizon.cursor.reset',
          dual_control_required: false,
          scope: 'CCONTRACT1',
        }),
      }),
    )
  })

  test('audit log records dual_control_required=true for dual-control actions', async () => {
    await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ action: 'user.hard_delete' })
      .expect(201)

    expect(mockedCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ dual_control_required: true }),
      }),
    )
  })
})

// ── HTTP integration tests: approve endpoint ──────────────────────────────────

describe('POST /api/admin/confirm/approve/:tokenId', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearConfirmationTokens()
  })

  test('second admin can approve a dual-control token', async () => {
    const prepareRes = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .send({ action: 'user.hard_delete' })
      .expect(201)

    const { tokenId } = prepareRes.body

    const approveRes = await request(app)
      .post(`/api/admin/confirm/approve/${tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(200)

    expect(approveRes.body.tokenId).toBe(tokenId)
    expect(approveRes.body.approvedBy).toBe('admin-2')
    expect(approveRes.body.approvedAt).toBeDefined()
    expect(approveRes.body.action).toBe('user.hard_delete')
  })

  test('self-approval is rejected with 409', async () => {
    const prepareRes = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .send({ action: 'user.hard_delete' })
      .expect(201)

    const res = await request(app)
      .post(`/api/admin/confirm/approve/${prepareRes.body.tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .expect(409)

    expect(res.body.error).toBe('self_approval_not_allowed')
  })

  test('approving a non-dual-control action token returns 409', async () => {
    const prepareRes = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .send({ action: 'horizon.cursor.reset' })
      .expect(201)

    const res = await request(app)
      .post(`/api/admin/confirm/approve/${prepareRes.body.tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(409)

    expect(res.body.error).toBe('action_does_not_require_approval')
  })

  test('approving non-existent token returns 404', async () => {
    await request(app)
      .post('/api/admin/confirm/approve/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(404)
  })

  test('double-approval returns 409', async () => {
    const prepareRes = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .send({ action: 'user.hard_delete' })
      .expect(201)

    await request(app)
      .post(`/api/admin/confirm/approve/${prepareRes.body.tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(200)

    const res = await request(app)
      .post(`/api/admin/confirm/approve/${prepareRes.body.tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(409)

    expect(res.body.error).toBe('already_approved')
  })

  test('audit log is created with correct fields on approval', async () => {
    const prepareRes = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .send({ action: 'user.hard_delete' })
      .expect(201)

    jest.clearAllMocks()

    await request(app)
      .post(`/api/admin/confirm/approve/${prepareRes.body.tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(200)

    expect(mockedCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.destructive_action.approved',
        actor_user_id: 'admin-2',
        target_type: 'confirmation_token',
        metadata: expect.objectContaining({
          destructive_action: 'user.hard_delete',
          prepared_by: 'admin-1',
          approved_by: 'admin-2',
        }),
      }),
    )
  })

  test('requires admin role', async () => {
    await request(app)
      .post('/api/admin/confirm/approve/some-token-id')
      .set('Authorization', `Bearer ${nonAdminToken()}`)
      .expect(403)
  })
})

// ── HTTP: guarded routes — rejection path (no service mocks needed) ────────────

describe('Confirmation token guard: POST /api/admin/horizon/listener/reset-cursor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearConfirmationTokens()
  })

  test('rejects request without any confirmation token (403)', async () => {
    const res = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1' })
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
    expect(res.body.action).toBe('horizon.cursor.reset')
    expect(res.body.prepareUrl).toBe('/api/admin/confirm/prepare')
  })

  test('rejects expired confirmation token (403)', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-28T00:00:00.000Z'))
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    jest.setSystemTime(new Date('2026-06-28T00:05:01.000Z'))

    const res = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1' })
      .expect(403)

    jest.useRealTimers()
    expect(res.body.confirmationRequired).toBe(true)
  })

  test('rejects wrong-scope confirmation token (403)', async () => {
    const entry = issueConfirmationToken('admin-1', 'embeddings.force_resync')

    const res = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1' })
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
  })

  test('rejects already-used (replayed) confirmation token (403)', async () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')
    validateConfirmationToken(entry.tokenId, 'admin-1', 'horizon.cursor.reset')

    const res = await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1' })
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
  })

  test('accepts valid confirmation token via header and executes the action', async () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')

    await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1' })
      .expect(200)
  })

  test('accepts valid confirmation token via request body', async () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')

    await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1', confirmationToken: entry.tokenId })
      .expect(200)
  })

  test('token is single-use: second request with same token is rejected', async () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')

    await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1' })
      .expect(200)

    await request(app)
      .post('/api/admin/horizon/listener/reset-cursor')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({ ledger: 100, contractAddress: 'CCONTRACT1' })
      .expect(403)
  })
})

describe('Confirmation token guard: DELETE /api/admin/users/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearConfirmationTokens()
  })

  test('soft-delete: rejects without confirmation token — action is user.soft_delete', async () => {
    const res = await request(app)
      .delete('/api/admin/users/user-to-delete')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
    expect(res.body.action).toBe('user.soft_delete')
  })

  test('hard-delete: rejects without confirmation token — action is user.hard_delete', async () => {
    const res = await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
    expect(res.body.action).toBe('user.hard_delete')
  })

  test('hard-delete: soft_delete token is rejected for hard_delete (wrong scope)', async () => {
    const entry = issueConfirmationToken('admin-1', 'user.soft_delete')

    const res = await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
  })

  test('soft-delete: accepts user.soft_delete token', async () => {
    const entry = issueConfirmationToken('admin-1', 'user.soft_delete')

    await request(app)
      .delete('/api/admin/users/user-to-delete')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .expect(200)
  })

  test('hard-delete: dual-control token without approval is rejected (403)', async () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')

    const res = await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
  })

  test('hard-delete: dual-control approved token succeeds', async () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    approveConfirmationToken(entry.tokenId, 'admin-2')

    await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .expect(200)
  })
})

describe('Confirmation token guard: POST /api/admin/embeddings/reembed', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearConfirmationTokens()
  })

  test('rejects request without confirmation token', async () => {
    const res = await request(app)
      .post('/api/admin/embeddings/reembed')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({})
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
    expect(res.body.action).toBe('embeddings.force_resync')
  })

  test('rejects wrong-scope token', async () => {
    const entry = issueConfirmationToken('admin-1', 'horizon.cursor.reset')

    const res = await request(app)
      .post('/api/admin/embeddings/reembed')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({})
      .expect(403)

    expect(res.body.confirmationRequired).toBe(true)
  })

  test('accepts valid embeddings.force_resync token', async () => {
    const entry = issueConfirmationToken('admin-1', 'embeddings.force_resync')

    await request(app)
      .post('/api/admin/embeddings/reembed')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .set('x-confirmation-token', entry.tokenId)
      .send({})
      .expect(202)
  })
})

// ── End-to-end dual-control flow via HTTP ─────────────────────────────────────

describe('Dual-control: full HTTP flow for user.hard_delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    clearConfirmationTokens()
  })

  test('full flow: prepare → fail-without-approval → approve → execute', async () => {
    // Step 1: Admin 1 prepares the token
    const prepareRes = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .send({ action: 'user.hard_delete', scope: 'user-to-delete' })
      .expect(201)

    const { tokenId } = prepareRes.body
    expect(prepareRes.body.dualControlRequired).toBe(true)
    expect(mockedCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.destructive_action.prepared', actor_user_id: 'admin-1' }),
    )

    // Step 2: Admin 1 tries to execute — must fail (no approval yet)
    await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .set('x-confirmation-token', tokenId)
      .expect(403)

    // Step 3: Admin 2 approves
    jest.clearAllMocks()
    await request(app)
      .post(`/api/admin/confirm/approve/${tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(200)

    expect(mockedCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.destructive_action.approved', actor_user_id: 'admin-2' }),
    )

    // Step 4: Admin 1 executes with the now-approved token
    jest.clearAllMocks()
    await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .set('x-confirmation-token', tokenId)
      .expect(200)

    expect(mockedCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.hard_delete', actor_user_id: 'admin-1' }),
    )
  })

  test('replay: approved token cannot be consumed twice', async () => {
    const entry = issueConfirmationToken('admin-1', 'user.hard_delete')
    approveConfirmationToken(entry.tokenId, 'admin-2')

    await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .set('x-confirmation-token', entry.tokenId)
      .expect(200)

    await request(app)
      .delete('/api/admin/users/user-to-delete?hard=true')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .set('x-confirmation-token', entry.tokenId)
      .expect(403)
  })

  test('expired dual-control token cannot be approved', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-28T00:00:00.000Z'))

    const prepareRes = await request(app)
      .post('/api/admin/confirm/prepare')
      .set('Authorization', `Bearer ${makeAdminToken('admin-1')}`)
      .send({ action: 'user.hard_delete' })
      .expect(201)

    jest.setSystemTime(new Date('2026-06-28T00:15:01.000Z'))

    const res = await request(app)
      .post(`/api/admin/confirm/approve/${prepareRes.body.tokenId}`)
      .set('Authorization', `Bearer ${makeAdminToken('admin-2')}`)
      .expect(409)

    jest.useRealTimers()
    expect(res.body.error).toBe('token_expired')
  })
})
