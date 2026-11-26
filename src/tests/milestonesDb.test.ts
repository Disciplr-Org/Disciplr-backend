import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { MilestoneService } from '../services/milestonesDb.js'
import { MilestoneRepositoryEnhanced } from '../repositories/milestoneRepositoryEnhanced.js'

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const FIXED_NOW = '2026-02-03T04:05:06.000Z'

const makeRepository = (create: jest.Mock) =>
  ({ create }) as unknown as MilestoneRepositoryEnhanced

describe('MilestoneService.createMilestone', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(FIXED_NOW))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('stores title and description separately and returns the persisted milestone', async () => {
    const create = jest.fn(async (row: Record<string, unknown>) => row)
    const service = new MilestoneService(makeRepository(create))

    const result = await service.createMilestone('vault-1', {
      title: 'Verify deployment',
      description: 'Confirm the deployment passed all checks',
    })

    expect(create).toHaveBeenCalledTimes(1)
    const persisted = create.mock.calls[0][0] as Record<string, unknown>
    expect(persisted).toMatchObject({
      vault_id: 'vault-1',
      title: 'Verify deployment',
      description: 'Confirm the deployment passed all checks',
      type: 'verifier',
      status: 'pending',
      weight: 1,
      created_at: FIXED_NOW,
    })
    expect(persisted.title).not.toBe(persisted.description)
    expect(String(persisted.id)).toMatch(UUID_V4)
    expect(result).toEqual({
      id: persisted.id,
      vaultId: 'vault-1',
      description: 'Confirm the deployment passed all checks',
      verified: false,
      verifiedAt: null,
      createdAt: FIXED_NOW,
    })
  })

  it('generates a distinct UUID for every milestone', async () => {
    const create = jest.fn(async (row: Record<string, unknown>) => row)
    const service = new MilestoneService(makeRepository(create))
    const input = { title: 'Review', description: 'Review the submitted artifact' }

    const first = await service.createMilestone('vault-1', input)
    const second = await service.createMilestone('vault-1', input)

    expect(first.id).toMatch(UUID_V4)
    expect(second.id).toMatch(UUID_V4)
    expect(first.id).not.toBe(second.id)
  })

  it('maps an approved repository row to a verified milestone', async () => {
    const create = jest.fn(async (row: Record<string, unknown>) => ({
      ...row,
      status: 'approved',
      updated_at: FIXED_NOW,
    }))
    const service = new MilestoneService(makeRepository(create))

    const result = await service.createMilestone('vault-2', {
      title: 'Ship',
      description: 'Ship the verified build',
    })

    expect(result.verified).toBe(true)
    expect(result.verifiedAt).toBe(FIXED_NOW)
  })

  it('propagates repository failures instead of returning a milestone', async () => {
    const create = jest.fn(async () => {
      throw new Error('milestone insert failed')
    })
    const service = new MilestoneService(makeRepository(create))

    await expect(
      service.createMilestone('vault-3', { title: 'Check', description: 'Run the check' }),
    ).rejects.toThrow('milestone insert failed')
  })
})
