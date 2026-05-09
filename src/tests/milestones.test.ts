import request from 'supertest'
import { app } from '../app.js'
import { describe, it, expect, beforeEach } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { vaults, setVaults, type Vault } from '../routes/vaults.js'
import { resetMilestonesTable, createMilestone } from '../services/milestones.js'
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
  `Bearer ${signToken({ userId: sub, role })}`

beforeEach(() => {
  setVaults([])
  resetMilestonesTable()
})

// ─── POST /api/vaults/:vaultId/milestones/:id/validate ─────────────────────────────────

describe('POST /api/vaults/:vaultId/milestones/:id/validate', () => {
  it('allows correct verifier to validate assigned milestone', async () => {
    const vault = makeVault({ verifier: 'verifier-123' })
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1', 'verifier-123')

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${ms.id}/validate`)
      .set('Authorization', tokenFor('verifier-123', UserRole.VERIFIER))
      .send()

    expect(res.status).toBe(200)
    expect(res.body.milestone.verified).toBe(true)
    expect(res.body.milestone.verifiedBy).toBe('verifier-123')
  })

  it('rejects wrong verifier', async () => {
    const vault = makeVault({ verifier: 'verifier-123' })
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1', 'verifier-123')

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${ms.id}/validate`)
      .set('Authorization', tokenFor('wrong-verifier', UserRole.VERIFIER))
      .send()

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/only assigned verifier/)
  })

  it('rejects non-verifier role', async () => {
    const vault = makeVault({ verifier: 'verifier-123' })
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1', 'verifier-123')

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${ms.id}/validate`)
      .set('Authorization', tokenFor('user-123', UserRole.USER))
      .send()

    expect(res.status).toBe(403)
  })

  it('rejects unauthenticated request', async () => {
    const vault = makeVault({ verifier: 'verifier-123' })
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1', 'verifier-123')

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${ms.id}/validate`)
      .send()

    expect(res.status).toBe(401)
  })

  it('returns conflict for already validated milestone', async () => {
    const vault = makeVault({ verifier: 'verifier-123' })
    vaults.push(vault)
    const ms = createMilestone(vault.id, 'task 1', 'verifier-123')

    // First validation
    await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${ms.id}/validate`)
      .set('Authorization', tokenFor('verifier-123', UserRole.VERIFIER))
      .send()

    // Second validation
    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/${ms.id}/validate`)
      .set('Authorization', tokenFor('verifier-123', UserRole.VERIFIER))
      .send()

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already validated/)
  })

  it('returns 404 for nonexistent vault', async () => {
    const res = await request(app)
      .post('/api/vaults/nonexistent/milestones/ms-123/validate')
      .set('Authorization', tokenFor('verifier-123', UserRole.VERIFIER))
      .send()

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Vault not found/)
  })

  it('returns 404 for nonexistent milestone', async () => {
    const vault = makeVault({ verifier: 'verifier-123' })
    vaults.push(vault)

    const res = await request(app)
      .post(`/api/vaults/${vault.id}/milestones/nonexistent/validate`)
      .set('Authorization', tokenFor('verifier-123', UserRole.VERIFIER))
      .send()

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Milestone not found/)
  })

  it('returns 404 for milestone in different vault', async () => {
    const vault1 = makeVault({ verifier: 'verifier-123' })
    const vault2 = makeVault({ verifier: 'verifier-456' })
    vaults.push(vault1, vault2)
    const ms = createMilestone(vault1.id, 'task 1', 'verifier-123')

    const res = await request(app)
      .post(`/api/vaults/${vault2.id}/milestones/${ms.id}/validate`)
      .set('Authorization', tokenFor('verifier-123', UserRole.VERIFIER))
      .send()

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Milestone not found/)
  })
})