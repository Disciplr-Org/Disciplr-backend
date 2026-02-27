import request from 'supertest'
import { app } from '../app.js'
import { describe, it, expect, beforeEach } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { vaults, setVaults, type Vault } from '../routes/vaults.js'
import { resetMilestonesTable, createMilestone, verifyMilestone } from '../services/milestones.js'
import {
  getTransitionError,
  completeVault,
  failVault,
  cancelVault,
  checkExpiredVaults,
} from '../services/vaultTransitions.js'
import { signToken } from '../middleware/auth.js'

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

const tokenFor = (sub: string, role: UserRole.USER | UserRole.VERIFIER | UserRole.ADMIN) =>
  `Bearer ${signToken({ sub, role })}`

beforeEach(() => {
  setVaults([])
  resetMilestonesTable()
})

// ─── getTransitionError ─────────────────────────────────────────────

describe('getTransitionError', () => {
  it('allows active → completed with all milestones verified', () => {
    const vault = makeVault()
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1')
    verifyMilestone(ms.id)

    expect(getTransitionError(vault, 'completed')).toBeNull()
  })

  it('rejects active → completed when milestones are not all verified', () => {
    const vault = makeVault()
    vaults.push(vault)
    createMilestone(vault.id, 'task 1')

    expect(getTransitionError(vault, 'completed')).toMatch(/not all milestones/)
  })

  it('rejects active → completed when there are zero milestones', () => {
    const vault = makeVault()
    vaults.push(vault)

    expect(getTransitionError(vault, 'completed')).toMatch(/not all milestones/)
  })

  it('allows active → failed when endTimestamp has passed', () => {
    const vault = makeVault({ endTimestamp: pastDate() })
    vaults.push(vault)

    expect(getTransitionError(vault, 'failed')).toBeNull()
  })

  it('rejects active → failed when endTimestamp is in the future', () => {
    const vault = makeVault({ endTimestamp: futureDate() })
    vaults.push(vault)

    expect(getTransitionError(vault, 'failed')).toMatch(/endTimestamp has not passed/)
  })

  it('allows active → cancelled by the creator', () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    expect(getTransitionError(vault, 'cancelled', 'alice')).toBeNull()
  })

  it('rejects active → cancelled by a non-creator', () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    expect(getTransitionError(vault, 'cancelled', 'bob')).toMatch(/only the creator/)
  })

  it('rejects transition from completed', () => {
    const vault = makeVault({ status: 'completed' })
    expect(getTransitionError(vault, 'cancelled', vault.creator)).toMatch(/already 'completed'/)
  })

  it('rejects transition from failed', () => {
    const vault = makeVault({ status: 'failed' })
    expect(getTransitionError(vault, 'completed')).toMatch(/already 'failed'/)
  })

  it('rejects transition from cancelled', () => {
    const vault = makeVault({ status: 'cancelled' })
    expect(getTransitionError(vault, 'failed')).toMatch(/already 'cancelled'/)
  })
})

// ─── completeVault ──────────────────────────────────────────────────

describe('completeVault', () => {
  it('succeeds when all milestones are verified', () => {
    const vault = makeVault()
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1')
    verifyMilestone(ms.id)

    const result = completeVault(vault.id)
    expect(result.success).toBe(true)
    expect(vault.status).toBe('completed')
  })

  it('fails when milestones are not verified', () => {
    const vault = makeVault()
    vaults.push(vault)
    createMilestone(vault.id, 'task 1')

    const result = completeVault(vault.id)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not all milestones/)
  })

  it('fails when vault is not found', () => {
    const result = completeVault('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('fails when vault is already completed', () => {
    const vault = makeVault({ status: 'completed' })
    vaults.push(vault)

    const result = completeVault(vault.id)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already 'completed'/)
  })
})

// ─── failVault ──────────────────────────────────────────────────────

describe('failVault', () => {
  it('succeeds when endTimestamp has passed', () => {
    const vault = makeVault({ endTimestamp: pastDate() })
    vaults.push(vault)

    const result = failVault(vault.id)
    expect(result.success).toBe(true)
    expect(vault.status).toBe('failed')
  })

  it('fails when endTimestamp is in the future', () => {
    const vault = makeVault({ endTimestamp: futureDate() })
    vaults.push(vault)

    const result = failVault(vault.id)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/endTimestamp has not passed/)
  })
})

// ─── cancelVault ────────────────────────────────────────────────────

describe('cancelVault', () => {
  it('succeeds when requester is the creator', () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    const result = cancelVault(vault.id, 'alice')
    expect(result.success).toBe(true)
    expect(vault.status).toBe('cancelled')
  })

  it('fails when requester is not the creator', () => {
    const vault = makeVault({ creator: 'alice' })
    vaults.push(vault)

    const result = cancelVault(vault.id, 'bob')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/only the creator/)
  })

  it('fails when vault is in a terminal state', () => {
    const vault = makeVault({ status: 'failed' })
    vaults.push(vault)

    const result = cancelVault(vault.id, vault.creator)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already 'failed'/)
  })
})

// ─── checkExpiredVaults ─────────────────────────────────────────────

describe('checkExpiredVaults', () => {
  it('fails all expired active vaults', () => {
    const v1 = makeVault({ endTimestamp: pastDate() })
    const v2 = makeVault({ endTimestamp: pastDate() })
    vaults.push(v1, v2)

    const expired = checkExpiredVaults()
    expect(expired).toContain(v1.id)
    expect(expired).toContain(v2.id)
    expect(v1.status).toBe('failed')
    expect(v2.status).toBe('failed')
  })

  it('ignores vaults already in a terminal state', () => {
    const v = makeVault({ endTimestamp: pastDate(), status: 'failed' })
    vaults.push(v)

    const expired = checkExpiredVaults()
    expect(expired).toHaveLength(0)
  })

  it('returns empty array when nothing is expired', () => {
    const v = makeVault({ endTimestamp: futureDate() })
    vaults.push(v)

    const expired = checkExpiredVaults()
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
      .set('Authorization', tokenFor('user-1', UserRole.USER))

    expect(res.status).toBe(200)
    expect(res.body.vault.status).toBe('cancelled')
  })

  it('returns 409 when requester is not the creator', async () => {
    const vault = makeVault({ creator: 'user-1' })
    vaults.push(vault)

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/cancel`)
      .set('Authorization', tokenFor('user-2', UserRole.USER))

    expect(res.status).toBe(409)
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

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones`)
      .set('Authorization', tokenFor('user-1', UserRole.USER))
      .send({ description: 'First milestone' })

    expect(res.status).toBe(201)
    expect(res.body.vaultId).toBe(vault.id)
    expect(res.body.description).toBe('First milestone')
    expect(res.body.verified).toBe(false)
  })

  it('GET lists milestones for a vault', async () => {
    const vault = makeVault()
    vaults.push(vault)
    createMilestone(vault.id, 'ms-1')
    createMilestone(vault.id, 'ms-2')

    const res = await request(app)
      .get(`/api/vaults/${vault.id}/milestones`)

    expect(res.status).toBe(200)
    expect(res.body.milestones).toHaveLength(2)
  })

  it('PATCH verify works with verifier role', async () => {
    const vault = makeVault()
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1')

    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/${ms.id}/verify`)
      .set('Authorization', tokenFor('verifier-1', UserRole.VERIFIER))

    expect(res.status).toBe(200)
    expect(res.body.milestone.verified).toBe(true)
    expect(res.body.vaultCompleted).toBe(true)
  })

  it('PATCH verify rejects user role', async () => {
    const vault = makeVault()
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1')

    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/${ms.id}/verify`)
      .set('Authorization', tokenFor('user-1', UserRole.USER))

    expect(res.status).toBe(403)
  })

  it('auto-completes vault when last milestone is verified', async () => {
    const vault = makeVault()
    vaults.push(vault)
    const ms1 = createMilestone(vault.id, 'task 1')
    const ms2 = createMilestone(vault.id, 'task 2')

    // Verify first milestone
    await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/${ms1.id}/verify`)
      .set('Authorization', tokenFor('v1', UserRole.VERIFIER))

    expect(vault.status).toBe('active')

    // Verify second (last) milestone
    const res = await request(app)
      .patch(`/api/vaults/${vault.id}/milestones/${ms2.id}/verify`)
      .set('Authorization', tokenFor('v1', UserRole.VERIFIER))

    expect(res.status).toBe(200)
    expect(res.body.vaultCompleted).toBe(true)
    expect(vault.status).toBe('completed')
  })
})
