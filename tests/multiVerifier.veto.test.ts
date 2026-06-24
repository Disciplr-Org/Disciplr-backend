/**
 * Veto-quorum settlement tests for multi-verifier milestones.
 * Uses the same mock pattern as verifications.transaction.test.ts.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// ---------------------------------------------------------------------------
// In-memory store for milestone_approvals
// ---------------------------------------------------------------------------
type Row = { id: string; milestone_id: string; verifier_user_id: string; approval_status: string; created_at: Date; updated_at: Date }
let store: Row[] = []
let idSeq = 0

function makeRow(milestoneId: string, verifierUserId: string, approvalStatus: string): Row {
  return {
    id: String(++idSeq),
    milestone_id: milestoneId,
    verifier_user_id: verifierUserId,
    approval_status: approvalStatus,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Minimal knex mock
// ---------------------------------------------------------------------------
function buildQuery(table: string) {
  const q: any = { _table: table, _wheres: {} as Record<string, unknown>, _status: undefined as string | undefined }

  q.where = (conds: Record<string, unknown>) => { Object.assign(q._wheres, conds); return q }
  q.first = async () => {
    if (q._table === 'milestone_approvals') {
      return store.find(r =>
        Object.entries(q._wheres).every(([k, v]) => (r as any)[k] === v)
      ) ?? null
    }
    return null
  }
  q.insert = (data: any) => {
    const row = { ...makeRow(data.milestone_id, data.verifier_user_id, data.approval_status), ...data }
    store.push(row)
    q._inserted = [row]
    return q
  }
  q.returning = (_fields: string) => q._inserted ?? []
  q.orderBy = () => q
  q.select = () => q
  // Make the query itself awaitable (resolves to rows matching wheres)
  q.then = (resolve: any, reject: any) => {
    try {
      const rows = store.filter(r =>
        Object.entries(q._wheres).every(([k, v]) => (r as any)[k] === v)
      )
      resolve(rows)
    } catch (e) { reject(e) }
    return Promise.resolve()
  }
  q.del = async () => { store = store.filter(r => !Object.entries(q._wheres).every(([k, v]) => (r as any)[k] === v)) }
  return q
}

jest.unstable_mockModule('../src/db/knex.js', () => {
  function db(table: string) { return buildQuery(table) }
  db.fn = { now: () => new Date() }
  db.transaction = async (cb: any) => cb(db)
  return { db, closeDatabase: jest.fn() }
})

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
const { recordMilestoneApproval, getMilestoneApprovalProgress, DuplicateVerifierVoteError, resetMilestoneApprovals } =
  await import('../src/services/verifiers.js')
const { createMilestoneWithThreshold, allMilestonesMetThreshold, resetMilestonesTable } =
  await import('../src/services/milestones.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function reset() {
  store = []
  idSeq = 0
  resetMilestonesTable()
}

async function vote(mid: string, vid: string, s: 'approved' | 'rejected') {
  return recordMilestoneApproval(mid, vid, s)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Veto math — getMilestoneApprovalProgress(id, M, N)', () => {
  const mid = 'veto-ms'

  beforeEach(reset)

  it('1-of-1: approval completes', async () => {
    await vote(mid, 'v1', 'approved')
    const p = await getMilestoneApprovalProgress(mid, 1, 1)
    expect(p.isComplete).toBe(true)
    expect(p.isRejected).toBe(false)
  })

  it('1-of-1: rejection → maxPossible=0 < 1 → vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 1, 1)
    expect(p.isRejected).toBe(true)
    expect(p.isComplete).toBe(false)
  })

  it('2-of-3: one rejection leaves maxPossible=2 ≥ 2 → NOT yet vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    // approved=0, rejected=1, remaining=2 → maxPossible=2 >= 2
    expect(p.isRejected).toBe(false)
  })

  it('2-of-3: two rejections → maxPossible=1 < 2 → vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    await vote(mid, 'v2', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    expect(p.isRejected).toBe(true)
    expect(p.isComplete).toBe(false)
  })

  it('2-of-3: two approvals meet threshold', async () => {
    await vote(mid, 'v1', 'approved')
    await vote(mid, 'v2', 'approved')
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    expect(p.isComplete).toBe(true)
    expect(p.isRejected).toBe(false)
  })

  it('2-of-3: two approvals + one rejection → still complete (threshold met, not vetoed)', async () => {
    await vote(mid, 'v1', 'approved')
    await vote(mid, 'v2', 'approved')
    await vote(mid, 'v3', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    expect(p.isComplete).toBe(true)
    expect(p.isRejected).toBe(false)
  })

  it('3-of-5: two rejections → remaining=3, maxPossible=3 ≥ 3 → not yet vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    await vote(mid, 'v2', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 3, 5)
    expect(p.isRejected).toBe(false)
  })

  it('3-of-5: three rejections → maxPossible=2 < 3 → vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    await vote(mid, 'v2', 'rejected')
    await vote(mid, 'v3', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 3, 5)
    expect(p.isRejected).toBe(true)
  })

  it('all-reject: all three reject on 2-of-3 → vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    await vote(mid, 'v2', 'rejected')
    await vote(mid, 'v3', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    expect(p.isRejected).toBe(true)
    expect(p.isComplete).toBe(false)
  })

  it('threshold > pool: maxPossible=N < M → vetoed even with no votes', async () => {
    // M=4, N=3: approved=0, remaining=3, maxPossible=3 < 4
    const p = await getMilestoneApprovalProgress(mid, 4, 3)
    expect(p.isRejected).toBe(true)
  })

  it('late vote after veto: progress still shows vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    await vote(mid, 'v2', 'rejected')
    // milestone already vetoed (2-of-3, 2 rejections)
    await vote(mid, 'v3', 'approved')
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    // approved=1, rejected=2, totalVoted=3, remaining=0 → maxPossible=1 < 2
    expect(p.isRejected).toBe(true)
    expect(p.isComplete).toBe(false)
  })
})

describe('approvalPercentage', () => {
  const mid = 'pct-ms'
  beforeEach(reset)

  it('is 0 with no votes', async () => {
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    expect(p.approvalPercentage).toBe(0)
  })

  it('is 100 when all votes are approvals', async () => {
    await vote(mid, 'v1', 'approved')
    await vote(mid, 'v2', 'approved')
    const p = await getMilestoneApprovalProgress(mid, 2, 2)
    expect(p.approvalPercentage).toBe(100)
  })

  it('is ~66.7 for 2 approved out of 3 total votes', async () => {
    await vote(mid, 'v1', 'approved')
    await vote(mid, 'v2', 'approved')
    await vote(mid, 'v3', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 2, 3)
    expect(p.approvalPercentage).toBeCloseTo(66.667, 1)
  })
})

describe('Legacy mode — no N', () => {
  const mid = 'legacy-ms'
  beforeEach(reset)

  it('isRejected=false with no rejections', async () => {
    await vote(mid, 'v1', 'approved')
    const p = await getMilestoneApprovalProgress(mid, 1)
    expect(p.isRejected).toBe(false)
    expect(p.isComplete).toBe(true)
  })

  it('isRejected=true on any single rejection', async () => {
    await vote(mid, 'v1', 'approved')
    await vote(mid, 'v2', 'rejected')
    const p = await getMilestoneApprovalProgress(mid, 2)
    expect(p.isRejected).toBe(true)
  })
})

describe('allMilestonesMetThreshold — veto-aware', () => {
  beforeEach(reset)

  it('returns false when a milestone is vetoed (2-of-3, 2 rejections)', () => {
    const vault = 'v-001'
    const m1 = createMilestoneWithThreshold(vault, 'Step 1', 2)
    const result = allMilestonesMetThreshold(
      vault,
      { [m1.id]: 0 },
      { [m1.id]: 2 },
      { [m1.id]: 3 },
    )
    expect(result).toBe(false)
  })

  it('returns true when milestone meets threshold and is not vetoed', () => {
    const vault = 'v-002'
    const m1 = createMilestoneWithThreshold(vault, 'Step 1', 2)
    const result = allMilestonesMetThreshold(
      vault,
      { [m1.id]: 2 },
      { [m1.id]: 0 },
      { [m1.id]: 3 },
    )
    expect(result).toBe(true)
  })

  it('returns false when one of two milestones is vetoed', () => {
    const vault = 'v-003'
    const m1 = createMilestoneWithThreshold(vault, 'Step 1', 1)
    const m2 = createMilestoneWithThreshold(vault, 'Step 2', 2)
    const result = allMilestonesMetThreshold(
      vault,
      { [m1.id]: 1, [m2.id]: 0 },
      { [m1.id]: 0, [m2.id]: 2 },
      { [m1.id]: 1, [m2.id]: 3 },
    )
    expect(result).toBe(false)
  })

  it('legacy: returns false if any rejection present without N', () => {
    const vault = 'v-004'
    const m1 = createMilestoneWithThreshold(vault, 'Step 1', 2)
    const result = allMilestonesMetThreshold(
      vault,
      { [m1.id]: 2 },
      { [m1.id]: 1 },
      // no totalVerifierCounts → legacy mode
    )
    expect(result).toBe(false)
  })

  it('backward compatible: threshold=1, single approval, no rejections → true', () => {
    const vault = 'v-005'
    const m1 = createMilestoneWithThreshold(vault, 'Step 1', 1)
    const result = allMilestonesMetThreshold(vault, { [m1.id]: 1 })
    expect(result).toBe(true)
  })
})

describe('Duplicate vote prevention', () => {
  const mid = 'dup-ms'
  beforeEach(reset)

  it('throws DuplicateVerifierVoteError on second vote by same verifier', async () => {
    await vote(mid, 'v1', 'approved')
    await expect(vote(mid, 'v1', 'rejected')).rejects.toThrow(DuplicateVerifierVoteError)
  })

  it('throws even after milestone is vetoed', async () => {
    await vote(mid, 'v1', 'rejected')
    await vote(mid, 'v2', 'rejected')
    await expect(vote(mid, 'v1', 'approved')).rejects.toThrow(DuplicateVerifierVoteError)
  })
})
