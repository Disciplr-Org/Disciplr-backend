import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, jest } from '@jest/globals'
import { Keypair } from '@stellar/stellar-sdk'
import { generateValidToken } from './helpers/rbacTestUtils.js'
import { UserRole } from '../types/user.js'
import { vaultsRouter } from '../routes/vaults.js'
import { milestonesRouter } from '../routes/milestones.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { canReadVault, type VaultActor } from '../services/vaultAccess.js'
import {
  setTestVaults,
  resetVaultStore,
  listVaults,
} from '../services/vaultStore.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'
import type { PersistedVault } from '../types/vaults.js'
import { setPgPoolForTest } from '../db/pool.js'

describe('Vault and milestone read authorisation (Issue #1719)', () => {
  // ─── Fixtures ──────────────────────────────────────────────────────────────
  const creatorWallet = Keypair.random().publicKey()
  const verifierWallet = Keypair.random().publicKey()
  const strangerWallet = Keypair.random().publicKey()
  const adminWallet = Keypair.random().publicKey()
  const orgMemberWallet = Keypair.random().publicKey()

  const creatorToken = generateValidToken({ userId: creatorWallet, role: UserRole.USER })
  const verifierToken = generateValidToken({ userId: verifierWallet, role: UserRole.VERIFIER })
  const strangerToken = generateValidToken({ userId: strangerWallet, role: UserRole.USER })
  const adminToken = generateValidToken({ userId: adminWallet, role: UserRole.ADMIN })
  const orgMemberToken = generateValidToken({ userId: orgMemberWallet, role: UserRole.USER })

  const personalVaultId = '11111111-1111-4111-8111-111111111111'
  const personalMilestoneId = 'ms-1-abcdef12'

  const orgVaultId = '33333333-3333-4333-8333-333333333333'
  const orgMilestoneId = 'ms-2-abcdef34'

  const deletedVaultId = '55555555-5555-4555-8555-555555555555'

  const personalVault: PersistedVault = {
    id: personalVaultId,
    amount: '1000',
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 86400000).toISOString(),
    verifier: verifierWallet,
    successDestination: Keypair.random().publicKey(),
    failureDestination: Keypair.random().publicKey(),
    creator: creatorWallet,
    status: 'active' as any,
    createdAt: '2026-01-01T10:00:00.000Z',
    lateCheckInWindowSecs: 3600,
    milestones: [
      {
        id: personalMilestoneId,
        vaultId: personalVaultId,
        title: 'Personal Milestone',
        description: 'Personal sensitive description',
        dueDate: new Date(Date.now() + 86400000).toISOString(),
        amount: '500',
        sortOrder: 0,
        verifierUserId: verifierWallet,
        createdAt: '2026-01-01T10:00:00.000Z',
      },
    ],
  }

  const orgVault: PersistedVault = {
    id: orgVaultId,
    amount: '2000',
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 86400000).toISOString(),
    verifier: verifierWallet,
    successDestination: Keypair.random().publicKey(),
    failureDestination: Keypair.random().publicKey(),
    creator: creatorWallet,
    status: 'active' as any,
    createdAt: '2026-01-02T10:00:00.000Z',
    lateCheckInWindowSecs: 3600,
    orgId: 'org_1',
    organization_id: 'org_1',
    milestones: [
      {
        id: orgMilestoneId,
        vaultId: orgVaultId,
        title: 'Org Milestone',
        description: 'Org confidential goal',
        dueDate: new Date(Date.now() + 86400000).toISOString(),
        amount: '1000',
        sortOrder: 0,
        verifierUserId: verifierWallet,
        createdAt: '2026-01-02T10:00:00.000Z',
      },
    ],
  }

  const deletedVault: PersistedVault = {
    id: deletedVaultId,
    amount: '3000',
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 86400000).toISOString(),
    verifier: verifierWallet,
    successDestination: Keypair.random().publicKey(),
    failureDestination: Keypair.random().publicKey(),
    creator: creatorWallet,
    status: 'active' as any,
    createdAt: '2026-01-03T10:00:00.000Z',
    lateCheckInWindowSecs: 3600,
    deletedAt: new Date().toISOString(),
    deleted_at: new Date().toISOString(),
    milestones: [],
  }

  let app: express.Express

  beforeEach(() => {
    resetVaultStore()
    setTestVaults([personalVault, orgVault, deletedVault])

    setOrganizations([
      { id: 'org_1', name: 'Org One', createdAt: new Date().toISOString() },
    ])
    setOrgMembers([
      { orgId: 'org_1', userId: orgMemberWallet, role: 'member' },
    ])

    app = express()
    app.use(express.json())
    app.use('/api/vaults/:vaultId/milestones', milestonesRouter)
    app.use('/api/vaults', vaultsRouter)
    app.use(errorHandler)
  })

  // ─── Table-Driven Tests over (route × actor) ───────────────────────────────
  describe('Table-driven access matrix over personal vault', () => {
    const cases = [
      { actor: 'creator', token: creatorToken, expectedStatus: 200 },
      { actor: 'verifier', token: verifierToken, expectedStatus: 200 },
      { actor: 'stranger', token: strangerToken, expectedStatus: 404 },
      { actor: 'admin', token: adminToken, expectedStatus: 200 },
      { actor: 'org_member', token: orgMemberToken, expectedStatus: 404 },
    ]

    describe.each(cases)('Actor: $actor', ({ token, expectedStatus }) => {
      it(`GET /api/vaults/:id returns ${expectedStatus}`, async () => {
        const res = await request(app)
          .get(`/api/vaults/${personalVaultId}`)
          .set('Authorization', `Bearer ${token}`)

        expect(res.status).toBe(expectedStatus)
        if (expectedStatus === 404) {
          expect(res.body).not.toHaveProperty('amount')
          expect(res.body).not.toHaveProperty('creator')
          expect(res.body).not.toHaveProperty('verifier')
          expect(res.body).not.toHaveProperty('milestones')
        }
      })

      it(`GET /api/vaults/:vaultId/milestones returns ${expectedStatus}`, async () => {
        const res = await request(app)
          .get(`/api/vaults/${personalVaultId}/milestones`)
          .set('Authorization', `Bearer ${token}`)

        expect(res.status).toBe(expectedStatus)
        if (expectedStatus === 404) {
          expect(res.body).not.toHaveProperty('milestones')
          expect(res.body).not.toHaveProperty('amount')
        }
      })

      it(`GET /api/vaults/:vaultId/milestones/:id/approval-status returns ${expectedStatus}`, async () => {
        const res = await request(app)
          .get(`/api/vaults/${personalVaultId}/milestones/${personalMilestoneId}/approval-status`)
          .set('Authorization', `Bearer ${token}`)

        expect(res.status).toBe(expectedStatus)
        if (expectedStatus === 404) {
          expect(res.body).not.toHaveProperty('approvalStatus')
          expect(res.body).not.toHaveProperty('milestone')
        }
      })

      it(`GET /api/vaults/:id/timeline returns ${expectedStatus}`, async () => {
        const res = await request(app)
          .get(`/api/vaults/${personalVaultId}/timeline`)
          .set('Authorization', `Bearer ${token}`)

        expect(res.status).toBe(expectedStatus)
        if (expectedStatus === 404) {
          expect(res.body).not.toHaveProperty('timeline')
        }
      })
    })
  })

  describe('Org vault read authorisation', () => {
    it('Org member can read org vault by id', async () => {
      const res = await request(app)
        .get(`/api/vaults/${orgVaultId}`)
        .set('Authorization', `Bearer ${orgMemberToken}`)

      expect(res.status).toBe(200)
      expect(res.body.id).toBe(orgVaultId)
    })

    it('Org member can read milestones of org vault', async () => {
      const res = await request(app)
        .get(`/api/vaults/${orgVaultId}/milestones`)
        .set('Authorization', `Bearer ${orgMemberToken}`)

      expect(res.status).toBe(200)
    })

    it('Non-member gets 404 for org vault and no fields leak', async () => {
      const res = await request(app)
        .get(`/api/vaults/${orgVaultId}`)
        .set('Authorization', `Bearer ${strangerToken}`)

      expect(res.status).toBe(404)
      expect(res.body).not.toHaveProperty('amount')
      expect(res.body).not.toHaveProperty('creator')
      expect(res.body).not.toHaveProperty('orgId')
    })
  })

  describe('Soft-deleted vault access', () => {
    it('Creator gets 404 for soft-deleted vault', async () => {
      const res = await request(app)
        .get(`/api/vaults/${deletedVaultId}`)
        .set('Authorization', `Bearer ${creatorToken}`)

      expect(res.status).toBe(404)
    })

    it('Verifier gets 404 for soft-deleted vault', async () => {
      const res = await request(app)
        .get(`/api/vaults/${deletedVaultId}`)
        .set('Authorization', `Bearer ${verifierToken}`)

      expect(res.status).toBe(404)
    })

    it('Stranger gets 404 for soft-deleted vault', async () => {
      const res = await request(app)
        .get(`/api/vaults/${deletedVaultId}`)
        .set('Authorization', `Bearer ${strangerToken}`)

      expect(res.status).toBe(404)
    })

    it('Admin can read soft-deleted vault', async () => {
      const res = await request(app)
        .get(`/api/vaults/${deletedVaultId}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(res.status).toBe(200)
      expect(res.body.id).toBe(deletedVaultId)
    })
  })

  describe('GET /api/vaults list endpoint scoping', () => {
    it("returns only caller's vaults for regular creator", async () => {
      const res = await request(app)
        .get('/api/vaults')
        .set('Authorization', `Bearer ${creatorToken}`)

      expect(res.status).toBe(200)
      const items = Array.isArray(res.body) ? res.body : (res.body.data ?? [])
      const ids = items.map((v: any) => v.id)
      expect(ids).toContain(personalVaultId)
      expect(ids).toContain(orgVaultId)
      // Soft-deleted vault stays hidden from creator
      expect(ids).not.toContain(deletedVaultId)
    })

    it('returns empty list for stranger with no vaults', async () => {
      const res = await request(app)
        .get('/api/vaults')
        .set('Authorization', `Bearer ${strangerToken}`)

      expect(res.status).toBe(200)
      const items = Array.isArray(res.body) ? res.body : (res.body.data ?? [])
      expect(items).toEqual([])
    })

    it('admin with ?all=true returns all vaults', async () => {
      const res = await request(app)
        .get('/api/vaults?all=true')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(res.status).toBe(200)
      const items = Array.isArray(res.body) ? res.body : (res.body.data ?? [])
      const ids = items.map((v: any) => v.id)
      expect(ids).toContain(personalVaultId)
      expect(ids).toContain(orgVaultId)
      expect(ids).toContain(deletedVaultId)
    })

    it('non-admin passing ?all=true is still scoped to caller', async () => {
      const res = await request(app)
        .get('/api/vaults?all=true')
        .set('Authorization', `Bearer ${strangerToken}`)

      expect(res.status).toBe(200)
      const items = Array.isArray(res.body) ? res.body : (res.body.data ?? [])
      expect(items).toEqual([])
    })
  })

  describe('GET /api/vaults/user/:address scoping', () => {
    it("creator can view their own address's vaults", async () => {
      const res = await request(app)
        .get(`/api/vaults/user/${creatorWallet}`)
        .set('Authorization', `Bearer ${creatorToken}`)

      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it("stranger requesting creator's address returns 403", async () => {
      const res = await request(app)
        .get(`/api/vaults/user/${creatorWallet}`)
        .set('Authorization', `Bearer ${strangerToken}`)

      expect(res.status).toBe(403)
      expect(res.body.error).toContain('Forbidden')
    })

    it("admin requesting creator's address returns 200", async () => {
      const res = await request(app)
        .get(`/api/vaults/user/${creatorWallet}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(res.status).toBe(200)
    })
  })

  // ─── Unit tests for canReadVault ───────────────────────────────────────────
  describe('canReadVault unit tests', () => {
    const testVault: PersistedVault = {
      id: 'test-vault-id',
      amount: '500',
      startDate: new Date().toISOString(),
      endDate: new Date().toISOString(),
      creator: 'user-creator',
      verifier: 'user-primary-verifier',
      successDestination: 'G1',
      failureDestination: 'G2',
      status: 'active' as any,
      createdAt: new Date().toISOString(),
      lateCheckInWindowSecs: 0,
      milestones: [
        {
          id: 'm1',
          vaultId: 'test-vault-id',
          title: 'M1',
          description: null,
          dueDate: new Date().toISOString(),
          amount: '100',
          sortOrder: 0,
          verifierUserId: 'user-milestone-verifier',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'm2',
          vaultId: 'test-vault-id',
          title: 'M2',
          description: null,
          dueDate: new Date().toISOString(),
          amount: '100',
          sortOrder: 1,
          verifierUserId: null,
          createdAt: new Date().toISOString(),
          // multi-verifier support
          approvals: [{ verifier_user_id: 'user-approval-verifier' }],
        } as any,
      ],
    }

    it('grants access to vault creator', () => {
      const actor: VaultActor = { userId: 'user-creator', role: UserRole.USER }
      expect(canReadVault(actor, testVault)).toBe(true)
    })

    it('grants access to primary verifier', () => {
      const actor: VaultActor = { userId: 'user-primary-verifier', role: UserRole.VERIFIER }
      expect(canReadVault(actor, testVault)).toBe(true)
    })

    it('grants access to milestone assigned verifier', () => {
      const actor: VaultActor = { userId: 'user-milestone-verifier', role: UserRole.VERIFIER }
      expect(canReadVault(actor, testVault)).toBe(true)
    })

    it('grants access to verifier in milestone approvals (multi-verifier)', () => {
      const actor: VaultActor = { userId: 'user-approval-verifier', role: UserRole.VERIFIER }
      expect(canReadVault(actor, testVault)).toBe(true)
    })

    it('grants access to admin', () => {
      const actor: VaultActor = { userId: 'user-admin', role: UserRole.ADMIN }
      expect(canReadVault(actor, testVault)).toBe(true)
    })

    it('denies access to unrelated stranger', () => {
      const actor: VaultActor = { userId: 'user-stranger', role: UserRole.USER }
      expect(canReadVault(actor, testVault)).toBe(false)
    })

    it('grants access to org member when orgId is set and role is member', () => {
      const orgScopedVault = {
        ...testVault,
        organization_id: 'org-123',
      }
      const actor: VaultActor = {
        userId: 'org-user',
        role: UserRole.USER,
        orgId: 'org-123',
        orgRole: 'member',
      }
      expect(canReadVault(actor, orgScopedVault)).toBe(true)
    })

    it('denies access to non-member when organization_id is set', () => {
      const orgScopedVault = {
        ...testVault,
        organization_id: 'org-123',
      }
      const actor: VaultActor = {
        userId: 'other-user',
        role: UserRole.USER,
        orgId: 'other-org',
      }
      expect(canReadVault(actor, orgScopedVault)).toBe(false)
    })

    it('denies access to soft-deleted vault for creator', () => {
      const deleted = {
        ...testVault,
        deletedAt: new Date().toISOString(),
      }
      const actor: VaultActor = { userId: 'user-creator', role: UserRole.USER }
      expect(canReadVault(actor, deleted)).toBe(false)
    })

    it('grants access to soft-deleted vault for admin', () => {
      const deleted = {
        ...testVault,
        deletedAt: new Date().toISOString(),
      }
      const actor: VaultActor = { userId: 'admin-user', role: UserRole.ADMIN }
      expect(canReadVault(actor, deleted)).toBe(true)
    })
  })

  // ─── Regression test for listVaults SQL filter ─────────────────────────────
  describe('listVaults SQL filter regression test', () => {
    it('pushes actor filter into SQL query when pool is present', async () => {
      const mockQuery = jest.fn<any>().mockResolvedValue({ rows: [] })
      const fakePool = { query: mockQuery } as any

      setPgPoolForTest(fakePool)

      try {
        const actor: VaultActor = {
          userId: 'user-123',
          role: UserRole.USER,
        }

        await listVaults({ actor })

        expect(mockQuery).toHaveBeenCalled()
        const sql = mockQuery.mock.calls[0][0] as string
        const params = mockQuery.mock.calls[0][1] as any[]

        // Assert actor filter is pushed into SQL WHERE clause
        expect(sql).toContain('WHERE')
        expect(sql).toContain('creator = ANY($1)')
        expect(sql).toContain('verifier = ANY($1)')
        expect(sql).toContain('milestones')
        expect(sql).toContain('deleted_at IS NULL')
        expect(params[0]).toContain('user-123')
      } finally {
        setPgPoolForTest(null)
      }
    })
  })
})
