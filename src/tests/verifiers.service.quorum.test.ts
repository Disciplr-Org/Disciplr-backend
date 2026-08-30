/**
 * Tests for #1529 — Service-layer invariants for verifier quorum and listing.
 *
 * Covers:
 *   - listVerifierProfiles: MAX_VERIFIER_PROFILES_LIMIT clamp
 *   - listVerifications: pagination opts (limit, offset, cap)
 *   - getMilestoneApprovalProgress: quorum invariant validation
 *     (threshold ≥ 1, totalVerifiers ≥ threshold)
 *   - canTransition: state-machine boundary coverage
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// ── Mock the DB ───────────────────────────────────────────────────────────────

const mockSelect = jest.fn()
const mockOrderBy = jest.fn()
const mockLimit = jest.fn()
const mockOffset = jest.fn()
const mockWhereIn = jest.fn()
const mockWhere = jest.fn()
const mockFirst = jest.fn()
const mockRaw = jest.fn()

// Each query builder method returns the builder itself so we can chain.
const queryBuilder: any = {
  select: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  first: jest.fn(),
  then: undefined, // Prevents Jest from treating it as a thenable
}

// Make the builder awaitable — resolves to empty array by default.
let _queryResult: any[] = []
const awaitableBuilder = new Proxy(queryBuilder, {
  get(target, prop) {
    if (prop === 'then') {
      return (resolve: any) => resolve(_queryResult)
    }
    return target[prop]
  },
})

const mockDb: any = jest.fn().mockReturnValue(awaitableBuilder)
mockDb.raw = jest.fn()
mockDb.fn = { now: jest.fn().mockReturnValue('NOW()') }
mockDb.transaction = jest.fn()

jest.unstable_mockModule('../db/knex.js', () => ({ db: mockDb }))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn().mockResolvedValue({ id: 'al-test' }),
}))

const {
  listVerifierProfiles,
  listVerifications,
  getMilestoneApprovalProgress,
  getMilestoneApprovals,
  canTransition,
  MAX_VERIFIER_PROFILES_LIMIT,
  MAX_VERIFICATIONS_LIMIT,
} = await import('../services/verifiers.js')

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetQueryBuilder(result: any[] = []) {
  _queryResult = result
  Object.values(queryBuilder).forEach((v) => {
    if (typeof v === 'function' && (v as any).mockReset) (v as any).mockReset()
  })
  // Re-attach chainable return
  ;['select', 'orderBy', 'limit', 'offset', 'whereIn', 'where'].forEach((m) => {
    queryBuilder[m].mockReturnValue(awaitableBuilder)
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('#1529 listVerifierProfiles — pagination bounds', () => {
  beforeEach(() => resetQueryBuilder([]))

  it('exports MAX_VERIFIER_PROFILES_LIMIT as 200', () => {
    expect(MAX_VERIFIER_PROFILES_LIMIT).toBe(200)
  })

  it('clamps limit to MAX_VERIFIER_PROFILES_LIMIT when caller passes a larger value', async () => {
    await listVerifierProfiles({ limit: 99999, offset: 0 })
    const limitCalls = awaitableBuilder.limit.mock.calls
    const calledWith = limitCalls[limitCalls.length - 1]?.[0]
    expect(calledWith).toBeLessThanOrEqual(200)
  })

  it('uses default limit (50) when no options are provided', async () => {
    await listVerifierProfiles()
    const limitCalls = awaitableBuilder.limit.mock.calls
    const calledWith = limitCalls[limitCalls.length - 1]?.[0]
    expect(calledWith).toBe(50)
  })

  it('passes offset correctly to the query', async () => {
    await listVerifierProfiles({ limit: 10, offset: 40 })
    const offsetCalls = awaitableBuilder.offset.mock.calls
    const calledWith = offsetCalls[offsetCalls.length - 1]?.[0]
    expect(calledWith).toBe(40)
  })

  it('treats a negative limit as the default (50)', async () => {
    await listVerifierProfiles({ limit: -1 })
    const limitCalls = awaitableBuilder.limit.mock.calls
    const calledWith = limitCalls[limitCalls.length - 1]?.[0]
    expect(calledWith).toBe(50)
  })

  it('treats a non-finite limit as the default (50)', async () => {
    await listVerifierProfiles({ limit: Infinity })
    const limitCalls = awaitableBuilder.limit.mock.calls
    const calledWith = limitCalls[limitCalls.length - 1]?.[0]
    expect(calledWith).toBe(50)
  })

  it('treats a negative offset as 0', async () => {
    await listVerifierProfiles({ limit: 10, offset: -5 })
    const offsetCalls = awaitableBuilder.offset.mock.calls
    const calledWith = offsetCalls[offsetCalls.length - 1]?.[0]
    expect(calledWith).toBe(0)
  })
})

describe('#1529 listVerifications — pagination bounds', () => {
  beforeEach(() => resetQueryBuilder([]))

  it('exports MAX_VERIFICATIONS_LIMIT as 500', () => {
    expect(MAX_VERIFICATIONS_LIMIT).toBe(500)
  })

  it('clamps limit to MAX_VERIFICATIONS_LIMIT when caller passes a larger value', async () => {
    await listVerifications(undefined, { limit: 99999, offset: 0 })
    const limitCalls = awaitableBuilder.limit.mock.calls
    const calledWith = limitCalls[limitCalls.length - 1]?.[0]
    expect(calledWith).toBeLessThanOrEqual(500)
  })

  it('uses default limit (100) when opts are omitted', async () => {
    await listVerifications()
    const limitCalls = awaitableBuilder.limit.mock.calls
    const calledWith = limitCalls[limitCalls.length - 1]?.[0]
    expect(calledWith).toBe(100)
  })

  it('passes offset to the query', async () => {
    await listVerifications(undefined, { limit: 20, offset: 100 })
    const offsetCalls = awaitableBuilder.offset.mock.calls
    const calledWith = offsetCalls[offsetCalls.length - 1]?.[0]
    expect(calledWith).toBe(100)
  })

  it('applies whereIn when targetIds are provided', async () => {
    await listVerifications(['t1', 't2'], { limit: 10 })
    expect(awaitableBuilder.whereIn).toHaveBeenCalledWith('target_id', ['t1', 't2'])
  })

  it('does NOT apply whereIn when targetIds is an empty array', async () => {
    await listVerifications([], { limit: 10 })
    expect(awaitableBuilder.whereIn).not.toHaveBeenCalled()
  })
})

describe('#1529 canTransition — state machine boundary coverage', () => {
  const cases: [string, string, boolean][] = [
    // Valid transitions
    ['pending', 'approved', true],
    ['pending', 'deactivated', true],
    ['pending', 'pending', true],       // Self-transition (idempotent)
    ['approved', 'suspended', true],
    ['approved', 'deactivated', true],
    ['approved', 'approved', true],
    ['suspended', 'approved', true],
    ['suspended', 'deactivated', true],
    ['suspended', 'suspended', true],
    ['deactivated', 'pending', true],
    ['deactivated', 'approved', true],
    ['deactivated', 'deactivated', true],
    // Invalid transitions
    ['pending', 'suspended', false],    // Cannot jump straight to suspended
    ['approved', 'pending', false],     // Cannot go back to pending from approved
    ['suspended', 'pending', false],    // Cannot go from suspended to pending directly
    ['deactivated', 'suspended', false],
  ]

  it.each(cases)('%s -> %s: canTransition returns %s', (from: any, to: any, expected) => {
    expect(canTransition(from, to)).toBe(expected)
  })
})

describe('#1529 getMilestoneApprovalProgress — quorum invariants', () => {
  beforeEach(() => {
    // getMilestoneApprovals queries the DB; mock it to return empty groups.
    mockDb.mockReturnValue({
      ...awaitableBuilder,
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnValue(Promise.resolve([])),
    })
  })

  it('throws when approvalThreshold is zero', async () => {
    await expect(getMilestoneApprovalProgress('m1', 0)).rejects.toThrow(/approvalThreshold.*positive integer/i)
  })

  it('throws when approvalThreshold is negative', async () => {
    await expect(getMilestoneApprovalProgress('m1', -1)).rejects.toThrow(/approvalThreshold.*positive integer/i)
  })

  it('throws when approvalThreshold is a non-integer (float)', async () => {
    await expect(getMilestoneApprovalProgress('m1', 1.5)).rejects.toThrow(/approvalThreshold.*positive integer/i)
  })

  it('throws when totalVerifiers is less than approvalThreshold', async () => {
    await expect(getMilestoneApprovalProgress('m1', 3, 2)).rejects.toThrow(/totalVerifiers.*approvalThreshold/i)
  })

  it('throws when totalVerifiers is zero', async () => {
    await expect(getMilestoneApprovalProgress('m1', 1, 0)).rejects.toThrow(/totalVerifiers.*positive integer/i)
  })

  it('throws when totalVerifiers is negative', async () => {
    await expect(getMilestoneApprovalProgress('m1', 1, -3)).rejects.toThrow(/totalVerifiers.*positive integer/i)
  })

  it('does NOT throw when totalVerifiers equals approvalThreshold (unanimous)', async () => {
    await expect(getMilestoneApprovalProgress('m1', 3, 3)).resolves.not.toThrow()
  })

  it('does NOT throw when totalVerifiers is omitted (legacy mode)', async () => {
    await expect(getMilestoneApprovalProgress('m1', 2)).resolves.not.toThrow()
  })

  it('returns required = approvalThreshold in the progress object', async () => {
    const progress = await getMilestoneApprovalProgress('m1', 2, 5)
    expect(progress.required).toBe(2)
  })

  it('isComplete=false and isRejected=false when no votes have been cast', async () => {
    const progress = await getMilestoneApprovalProgress('m1', 2, 5)
    expect(progress.isComplete).toBe(false)
    expect(progress.isRejected).toBe(false)
    expect(progress.approved).toBe(0)
    expect(progress.rejected).toBe(0)
  })
})
