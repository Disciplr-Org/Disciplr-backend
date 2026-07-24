import { describe, expect, it } from '@jest/globals'
import { toPublicVault, toPublicMilestone } from '../utils/mappers.js'
import { VaultStatus } from '../types/vault.js'
import type { Vault } from '../types/vault.js'
import type { Milestone } from '../types/horizonSync.js'

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeVault(overrides: Partial<Vault> = {}): Vault {
  return {
    id: 'vault-001',
    contract_id: 'CONTRACT-ABC',
    creator_address: 'GCREATOR123',
    amount: '1000',
    milestone_hash: 'hash-abc',
    verifier_address: 'GVERIFIER456',
    success_destination: 'GSUCCESS789',
    failure_destination: 'GFAILURE000',
    status: VaultStatus.ACTIVE,
    deadline: new Date('2026-12-31T23:59:59.000Z'),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'milestone-001',
    vaultId: 'vault-001',
    title: 'First milestone',
    description: 'Do the thing',
    targetAmount: '500',
    currentAmount: '250',
    deadline: new Date('2026-06-30T00:00:00.000Z'),
    status: 'pending',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

// ── toPublicVault ─────────────────────────────────────────────────────────

describe('toPublicVault', () => {
  it('maps all public fields correctly', () => {
    const vault = makeVault()
    const dto = toPublicVault(vault)

    expect(dto.id).toBe('vault-001')
    expect(dto.creator).toBe('GCREATOR123')
    expect(dto.amount).toBe('1000')
    expect(dto.status).toBe('active')
    expect(dto.successDestination).toBe('GSUCCESS789')
    expect(dto.failureDestination).toBe('GFAILURE000')
  })

  it('converts created_at to ISO 8601 UTC string for startTimestamp', () => {
    const vault = makeVault({ created_at: new Date('2026-01-01T00:00:00.000Z') })
    const dto = toPublicVault(vault)
    expect(dto.startTimestamp).toBe('2026-01-01T00:00:00.000Z')
  })

  it('converts deadline to ISO 8601 UTC string for endTimestamp', () => {
    const vault = makeVault({ deadline: new Date('2026-12-31T23:59:59.000Z') })
    const dto = toPublicVault(vault)
    expect(dto.endTimestamp).toBe('2026-12-31T23:59:59.000Z')
  })

  it('startTimestamp and endTimestamp always end with Z', () => {
    const dto = toPublicVault(makeVault())
    expect(dto.startTimestamp).toMatch(/Z$/)
    expect(dto.endTimestamp).toMatch(/Z$/)
  })

  it('does not leak internal fields into the DTO', () => {
    const dto = toPublicVault(makeVault()) as Record<string, unknown>
    expect(dto).not.toHaveProperty('created_at')
    expect(dto).not.toHaveProperty('updated_at')
    expect(dto).not.toHaveProperty('contract_id')
    expect(dto).not.toHaveProperty('milestone_hash')
    expect(dto).not.toHaveProperty('verifier_address')
    expect(dto).not.toHaveProperty('organization_id')
    expect(dto).not.toHaveProperty('creator_address')
    expect(dto).not.toHaveProperty('deadline')
  })

  it('preserves exact amount string without coercion', () => {
    const dto = toPublicVault(makeVault({ amount: '99999999.99' }))
    expect(dto.amount).toBe('99999999.99')
  })

  it('maps PENDING status correctly', () => {
    const dto = toPublicVault(makeVault({ status: VaultStatus.PENDING }))
    expect(dto.status).toBe('pending')
  })

  it('maps COMPLETED status correctly', () => {
    const dto = toPublicVault(makeVault({ status: VaultStatus.COMPLETED }))
    expect(dto.status).toBe('completed')
  })

  it('maps FAILED status correctly', () => {
    const dto = toPublicVault(makeVault({ status: VaultStatus.FAILED }))
    expect(dto.status).toBe('failed')
  })

  it('maps CANCELLED status correctly', () => {
    const dto = toPublicVault(makeVault({ status: VaultStatus.CANCELLED }))
    expect(dto.status).toBe('cancelled')
  })

  it('handles optional organization_id being absent', () => {
    const vault = makeVault()
    delete vault.organization_id
    expect(() => toPublicVault(vault)).not.toThrow()
  })

  it('round-trips id, creator, amount, destinations without mutation', () => {
    const vault = makeVault()
    const dto = toPublicVault(vault)
    expect(dto.id).toBe(vault.id)
    expect(dto.creator).toBe(vault.creator_address)
    expect(dto.amount).toBe(vault.amount)
    expect(dto.successDestination).toBe(vault.success_destination)
    expect(dto.failureDestination).toBe(vault.failure_destination)
  })

  it('produces only the documented DTO keys', () => {
    const dto = toPublicVault(makeVault())
    const keys = Object.keys(dto).sort()
    expect(keys).toEqual([
      'amount',
      'creator',
      'endTimestamp',
      'failureDestination',
      'id',
      'startTimestamp',
      'status',
      'successDestination',
    ])
  })
})

// ── toPublicMilestone ─────────────────────────────────────────────────────

describe('toPublicMilestone', () => {
  it('maps all public fields correctly', () => {
    const milestone = makeMilestone()
    const dto = toPublicMilestone(milestone)

    expect(dto.id).toBe('milestone-001')
    expect(dto.vaultId).toBe('vault-001')
    expect(dto.title).toBe('First milestone')
    expect(dto.description).toBe('Do the thing')
    expect(dto.targetAmount).toBe('500')
    expect(dto.currentAmount).toBe('250')
    expect(dto.status).toBe('pending')
  })

  it('converts deadline Date to ISO 8601 UTC string', () => {
    const milestone = makeMilestone({ deadline: new Date('2026-06-30T00:00:00.000Z') })
    const dto = toPublicMilestone(milestone)
    expect(dto.deadline).toBe('2026-06-30T00:00:00.000Z')
  })

  it('deadline always ends with Z', () => {
    const dto = toPublicMilestone(makeMilestone())
    expect(dto.deadline).toMatch(/Z$/)
  })

  it('maps null description without throwing', () => {
    const dto = toPublicMilestone(makeMilestone({ description: null }))
    expect(dto.description).toBeNull()
  })

  it('does not leak internal fields into the DTO', () => {
    const dto = toPublicMilestone(makeMilestone()) as Record<string, unknown>
    expect(dto).not.toHaveProperty('createdAt')
    expect(dto).not.toHaveProperty('updatedAt')
  })

  it('maps all milestone status values correctly', () => {
    const statuses = ['pending', 'in_progress', 'completed', 'failed'] as const
    for (const status of statuses) {
      const dto = toPublicMilestone(makeMilestone({ status }))
      expect(dto.status).toBe(status)
    }
  })

  it('round-trips all fields without mutation', () => {
    const milestone = makeMilestone()
    const dto = toPublicMilestone(milestone)
    expect(dto.id).toBe(milestone.id)
    expect(dto.vaultId).toBe(milestone.vaultId)
    expect(dto.title).toBe(milestone.title)
    expect(dto.targetAmount).toBe(milestone.targetAmount)
    expect(dto.currentAmount).toBe(milestone.currentAmount)
  })

  it('produces only the documented DTO keys', () => {
    const dto = toPublicMilestone(makeMilestone())
    const keys = Object.keys(dto).sort()
    expect(keys).toEqual([
      'currentAmount',
      'deadline',
      'description',
      'id',
      'status',
      'targetAmount',
      'title',
      'vaultId',
    ])
  })

  it('preserves exact amount strings without coercion', () => {
    const dto = toPublicMilestone(makeMilestone({ targetAmount: '12345.67', currentAmount: '0.01' }))
    expect(dto.targetAmount).toBe('12345.67')
    expect(dto.currentAmount).toBe('0.01')
  })
})