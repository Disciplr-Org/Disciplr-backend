/**
 * Multi-verifier milestone approval system tests.
 * Uses an in-memory knex mock — no real DB required.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
type Row = {
  id: string
  milestone_id: string
  verifier_user_id: string
  approval_status: string
  created_at: Date
  updated_at: Date
}
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
// Minimal knex mock (same shape as veto test)
// ---------------------------------------------------------------------------
function buildQuery(table: string) {
  const q: any = { _table: table, _wheres: {} as Record<string, unknown>, _inserted: undefined as Row[] | undefined }

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
  q.count = <T>(_expr: string) => {
    // Returns a query that resolves to [{ count: N }]
    const countQ: any = { _wheres: { ...q._wheres }, _table: q._table }
    countQ.where = (conds: Record<string, unknown>) => { Object.assign(countQ._wheres, conds); return countQ }
    countQ.first = async () => {
      const count = store.filter(r =>
        Object.entries(countQ._wheres).every(([k, v]) => (r as any)[k] === v)
      ).length
      return { count: String(count) }
    }
    countQ.then = (resolve: any, reject: any) => {
      try {
        const count = store.filter(r =>
          Object.entries(countQ._wheres).every(([k, v]) => (r as any)[k] === v)
        ).length
        resolve([{ count: String(count) }])
      } catch (e) { reject(e) }
      return Promise.resolve()
    }
    return countQ
  }
  // Make the query itself awaitable — resolves to matching rows
  q.then = (resolve: any, reject: any) => {
    try {
      const rows = store.filter(r =>
        Object.entries(q._wheres).every(([k, v]) => (r as any)[k] === v)
      )
      resolve(rows)
    } catch (e) { reject(e) }
    return Promise.resolve()
  }
  q.del = async () => {
    store = store.filter(r =>
      !Object.entries(q._wheres).every(([k, v]) => (r as any)[k] === v)
    )
  }
  return q
}

jest.unstable_mockModule('../src/db/knex.js', () => {
  function db(table: string) { return buildQuery(table) }
  db.fn = { now: () => new Date() }
  db.transaction = async (cb: any) => cb(db)
  return { db, closeDatabase: jest.fn() }
})

// ---------------------------------------------------------------------------
// Imports must come after mock registration
// ---------------------------------------------------------------------------
const {
  recordMilestoneApproval,
  getMilestoneApprovals,
  getApprovedVerifiersCount,
  getAllMilestoneVotes,
  hasVerifierVoted,
  hasMilestoneMetThreshold,
  getMilestoneApprovalProgress,
  DuplicateVerifierVoteError,
  resetMilestoneApprovals,
} = await import('../src/services/verifiers.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function reset() {
  store = []
  idSeq = 0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Multi-Verifier Milestone Approval System', () => {
  const testMilestoneId = 'test-milestone-001'
  const testVerifiers = ['verifier-1', 'verifier-2', 'verifier-3']
  const thresholdMofN = 2 // 2-of-3 threshold

  beforeEach(reset)
  afterEach(reset)

  describe('recordMilestoneApproval', () => {
    it('should record a milestone approval successfully', async () => {
      const approval = await recordMilestoneApproval(
        testMilestoneId,
        testVerifiers[0],
        'approved',
      )

      expect(approval).toBeDefined()
      expect(approval.milestoneId).toBe(testMilestoneId)
      expect(approval.verifierUserId).toBe(testVerifiers[0])
      expect(approval.approvalStatus).toBe('approved')
      expect(approval.createdAt).toBeDefined()
    })

    it('should record a milestone rejection successfully', async () => {
      const approval = await recordMilestoneApproval(
        testMilestoneId,
        testVerifiers[0],
        'rejected',
      )

      expect(approval.approvalStatus).toBe('rejected')
    })

    it('should throw DuplicateVerifierVoteError on duplicate vote', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')

      await expect(
        recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved'),
      ).rejects.toThrow(DuplicateVerifierVoteError)
    })

    it('should allow different verifiers to vote on same milestone', async () => {
      const approval1 = await recordMilestoneApproval(
        testMilestoneId,
        testVerifiers[0],
        'approved',
      )
      const approval2 = await recordMilestoneApproval(
        testMilestoneId,
        testVerifiers[1],
        'approved',
      )

      expect(approval1.verifierUserId).not.toBe(approval2.verifierUserId)
    })
  })

  describe('Duplicate Vote Prevention', () => {
    it('should prevent a verifier from approving twice', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')

      await expect(
        recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved'),
      ).rejects.toThrow('has already voted')
    })

    it('should prevent a verifier from changing their vote', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')

      await expect(
        recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'rejected'),
      ).rejects.toThrow(DuplicateVerifierVoteError)
    })

    it('should validate vote uniqueness across multiple verifiers', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[2], 'rejected')

      await expect(
        recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved'),
      ).rejects.toThrow()
      await expect(
        recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved'),
      ).rejects.toThrow()
      await expect(
        recordMilestoneApproval(testMilestoneId, testVerifiers[2], 'approved'),
      ).rejects.toThrow()
    })
  })

  describe('getMilestoneApprovals', () => {
    it('should return empty approval lists for new milestone', async () => {
      const approvals = await getMilestoneApprovals(testMilestoneId)

      expect(approvals.approved.length).toBe(0)
      expect(approvals.rejected.length).toBe(0)
      expect(approvals.pending.length).toBe(0)
    })

    it('should group approvals by status', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[2], 'rejected')

      const approvals = await getMilestoneApprovals(testMilestoneId)

      expect(approvals.approved.length).toBe(2)
      expect(approvals.rejected.length).toBe(1)
      expect(approvals.pending.length).toBe(0)
    })

    it('should maintain order of approvals by timestamp', async () => {
      const milestoneId = 'ordered-milestone'
      await recordMilestoneApproval(milestoneId, 'verifier-a', 'approved')
      await new Promise((resolve) => setTimeout(resolve, 10))
      await recordMilestoneApproval(milestoneId, 'verifier-b', 'approved')

      const approvals = await getMilestoneApprovals(milestoneId)
      expect(approvals.approved[0].verifierUserId).toBe('verifier-a')
      expect(approvals.approved[1].verifierUserId).toBe('verifier-b')
    })
  })

  describe('getApprovedVerifiersCount', () => {
    it('should return 0 for milestone with no approvals', async () => {
      const count = await getApprovedVerifiersCount(testMilestoneId)
      expect(count).toBe(0)
    })

    it('should count only approved votes, not rejections', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[2], 'rejected')

      const count = await getApprovedVerifiersCount(testMilestoneId)
      expect(count).toBe(2)
    })

    it('should return accurate count for multiple approvals', async () => {
      for (let i = 0; i < 5; i++) {
        await recordMilestoneApproval(testMilestoneId, `verifier-${i}`, 'approved')
      }

      const count = await getApprovedVerifiersCount(testMilestoneId)
      expect(count).toBe(5)
    })
  })

  describe('hasVerifierVoted', () => {
    it('should return false for verifier who has not voted', async () => {
      const hasVoted = await hasVerifierVoted(testMilestoneId, testVerifiers[0])
      expect(hasVoted).toBe(false)
    })

    it('should return true for verifier who has voted', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      const hasVoted = await hasVerifierVoted(testMilestoneId, testVerifiers[0])
      expect(hasVoted).toBe(true)
    })

    it('should distinguish between different verifiers', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')

      const verifier0Voted = await hasVerifierVoted(testMilestoneId, testVerifiers[0])
      const verifier1Voted = await hasVerifierVoted(testMilestoneId, testVerifiers[1])

      expect(verifier0Voted).toBe(true)
      expect(verifier1Voted).toBe(false)
    })

    it('should return true regardless of approval status', async () => {
      const milestoneId = 'test-milestone-vote-status'
      await recordMilestoneApproval(milestoneId, 'verifier-reject', 'rejected')
      await recordMilestoneApproval(milestoneId, 'verifier-approve', 'approved')

      const hasVotedReject = await hasVerifierVoted(milestoneId, 'verifier-reject')
      const hasVotedApprove = await hasVerifierVoted(milestoneId, 'verifier-approve')

      expect(hasVotedReject).toBe(true)
      expect(hasVotedApprove).toBe(true)
    })
  })

  describe('hasMilestoneMetThreshold', () => {
    it('should return true when approved count meets threshold', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved')

      const met = await hasMilestoneMetThreshold(testMilestoneId, thresholdMofN)
      expect(met).toBe(true)
    })

    it('should return false when approved count below threshold', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')

      const met = await hasMilestoneMetThreshold(testMilestoneId, thresholdMofN)
      expect(met).toBe(false)
    })

    it('should return false for milestone with only rejections', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'rejected')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'rejected')

      const met = await hasMilestoneMetThreshold(testMilestoneId, thresholdMofN)
      expect(met).toBe(false)
    })

    it('should support threshold of 1', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')

      const met = await hasMilestoneMetThreshold(testMilestoneId, 1)
      expect(met).toBe(true)
    })

    it('should support high thresholds', async () => {
      for (let i = 0; i < 5; i++) {
        await recordMilestoneApproval(testMilestoneId, `verifier-${i}`, 'approved')
      }

      const met5 = await hasMilestoneMetThreshold(testMilestoneId, 5)
      const met6 = await hasMilestoneMetThreshold(testMilestoneId, 6)

      expect(met5).toBe(true)
      expect(met6).toBe(false)
    })
  })

  describe('getMilestoneApprovalProgress', () => {
    it('should calculate approval progress correctly', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[2], 'rejected')

      const progress = await getMilestoneApprovalProgress(testMilestoneId, 2)

      expect(progress.approved).toBe(2)
      expect(progress.rejected).toBe(1)
      expect(progress.pending).toBe(0)
      expect(progress.required).toBe(2)
    })

    it('should indicate completion when threshold is met', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved')

      const progress = await getMilestoneApprovalProgress(testMilestoneId, 2)

      expect(progress.isComplete).toBe(true)
      expect(progress.isRejected).toBe(false)
    })

    it('should indicate rejection if any verifier rejects (legacy mode, no N)', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'rejected')

      const progress = await getMilestoneApprovalProgress(testMilestoneId, 2)

      expect(progress.isRejected).toBe(true)
    })

    it('should calculate approval percentage', async () => {
      const milestoneId = 'percentage-test'
      await recordMilestoneApproval(milestoneId, 'verifier-1', 'approved')
      await recordMilestoneApproval(milestoneId, 'verifier-2', 'approved')
      await recordMilestoneApproval(milestoneId, 'verifier-3', 'rejected')

      const progress = await getMilestoneApprovalProgress(milestoneId, 2)

      expect(progress.approvalPercentage).toBe(66.66666666666666) // 2 of 3
    })

    it('should return 0 approval percentage for new milestone', async () => {
      const progress = await getMilestoneApprovalProgress(testMilestoneId, 3)

      expect(progress.approvalPercentage).toBe(0)
    })

    it('should return 100 approval percentage when all approve', async () => {
      const milestoneId = 'all-approve'
      await recordMilestoneApproval(milestoneId, 'v1', 'approved')
      await recordMilestoneApproval(milestoneId, 'v2', 'approved')
      await recordMilestoneApproval(milestoneId, 'v3', 'approved')

      const progress = await getMilestoneApprovalProgress(milestoneId, 2)

      expect(progress.approvalPercentage).toBe(100)
    })
  })

  describe('getAllMilestoneVotes', () => {
    it('should return all votes in order', async () => {
      await recordMilestoneApproval(testMilestoneId, testVerifiers[0], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[1], 'approved')
      await recordMilestoneApproval(testMilestoneId, testVerifiers[2], 'rejected')

      const votes = await getAllMilestoneVotes(testMilestoneId)

      expect(votes.length).toBe(3)
      expect(votes[0].verifierUserId).toBe(testVerifiers[0])
      expect(votes[1].verifierUserId).toBe(testVerifiers[1])
      expect(votes[2].verifierUserId).toBe(testVerifiers[2])
    })

    it('should return empty array for milestone with no votes', async () => {
      const votes = await getAllMilestoneVotes(testMilestoneId)
      expect(votes.length).toBe(0)
    })
  })

  describe('Integration: M-of-N Approval Flow', () => {
    it('should complete 2-of-3 milestone approval', async () => {
      const milestoneId = '2of3-milestone'

      const approval1 = await recordMilestoneApproval(milestoneId, 'v1', 'approved')
      expect(approval1.approvalStatus).toBe('approved')

      let progress = await getMilestoneApprovalProgress(milestoneId, 2)
      expect(progress.isComplete).toBe(false)
      expect(progress.approved).toBe(1)

      const approval2 = await recordMilestoneApproval(milestoneId, 'v2', 'approved')
      expect(approval2.approvalStatus).toBe('approved')

      progress = await getMilestoneApprovalProgress(milestoneId, 2)
      expect(progress.isComplete).toBe(true)
      expect(progress.approved).toBe(2)

      const approval3 = await recordMilestoneApproval(milestoneId, 'v3', 'approved')
      expect(approval3.approvalStatus).toBe('approved')

      progress = await getMilestoneApprovalProgress(milestoneId, 2)
      expect(progress.approved).toBe(3)
      expect(progress.isComplete).toBe(true)
    })

    it('should fail milestone on any rejection (legacy: no N)', async () => {
      const milestoneId = 'rejection-milestone'

      await recordMilestoneApproval(milestoneId, 'v1', 'approved')
      await recordMilestoneApproval(milestoneId, 'v2', 'rejected')

      const progress = await getMilestoneApprovalProgress(milestoneId, 2)

      expect(progress.isRejected).toBe(true)
      expect(progress.isComplete).toBe(false)
    })

    it('should handle 3-of-5 threshold', async () => {
      const milestoneId = '3of5-milestone'

      for (let i = 0; i < 3; i++) {
        await recordMilestoneApproval(milestoneId, `v${i}`, 'approved')
      }

      let progress = await getMilestoneApprovalProgress(milestoneId, 3)
      expect(progress.isComplete).toBe(true)

      await recordMilestoneApproval(milestoneId, 'v3', 'approved')
      await recordMilestoneApproval(milestoneId, 'v4', 'approved')

      progress = await getMilestoneApprovalProgress(milestoneId, 3)
      expect(progress.approved).toBe(5)
      expect(progress.isComplete).toBe(true)
    })

    it('should prevent double voting throughout workflow', async () => {
      const milestoneId = 'double-vote-test'

      await recordMilestoneApproval(milestoneId, 'v1', 'approved')

      await expect(
        recordMilestoneApproval(milestoneId, 'v1', 'approved'),
      ).rejects.toThrow(DuplicateVerifierVoteError)

      const approval2 = await recordMilestoneApproval(milestoneId, 'v2', 'approved')
      expect(approval2.verifierUserId).toBe('v2')
    })
  })

  describe('Edge Cases and Security', () => {
    it('should handle empty milestone ID', async () => {
      const approval = await recordMilestoneApproval('', 'verifier-1', 'approved')
      expect(approval.milestoneId).toBe('')
    })

    it('should handle special characters in IDs', async () => {
      const specialId = 'milestone-with-!@#$%special'
      const approval = await recordMilestoneApproval(specialId, 'verifier', 'approved')
      expect(approval.milestoneId).toBe(specialId)
    })

    it('should handle very long verifier IDs', async () => {
      const longVerifierId = 'v' + 'e'.repeat(1000)
      const approval = await recordMilestoneApproval(testMilestoneId, longVerifierId, 'approved')
      expect(approval.verifierUserId).toBe(longVerifierId)
    })

    it('should be case-sensitive for verifier IDs', async () => {
      const milestoneId = 'case-test'
      await recordMilestoneApproval(milestoneId, 'Verifier', 'approved')

      const approval2 = await recordMilestoneApproval(milestoneId, 'verifier', 'approved')
      expect(approval2.verifierUserId).toBe('verifier')

      await expect(
        recordMilestoneApproval(milestoneId, 'Verifier', 'approved'),
      ).rejects.toThrow()
    })

    it('should maintain data consistency across multiple operations', async () => {
      const milestoneId = 'consistency-test'

      for (let i = 0; i < 10; i++) {
        await recordMilestoneApproval(milestoneId, `verifier-${i}`, 'approved')
      }

      const approvals = await getMilestoneApprovals(milestoneId)
      const count = await getApprovedVerifiersCount(milestoneId)
      const votes = await getAllMilestoneVotes(milestoneId)

      expect(approvals.approved.length).toBe(10)
      expect(count).toBe(10)
      expect(votes.length).toBe(10)
    })

    it('should handle mixed approval statuses', async () => {
      const milestoneId = 'mixed-status'

      const statuses = ['approved', 'rejected', 'approved', 'pending', 'rejected', 'approved']
      for (let i = 0; i < statuses.length; i++) {
        await recordMilestoneApproval(
          milestoneId,
          `verifier-${i}`,
          statuses[i] as any,
        )
      }

      const approvals = await getMilestoneApprovals(milestoneId)
      expect(approvals.approved.length).toBe(3)
      expect(approvals.rejected.length).toBe(2)
      expect(approvals.pending.length).toBe(1)
    })
  })

  describe('Test Coverage', () => {
    it('should have all functions exported', () => {
      expect(typeof recordMilestoneApproval).toBe('function')
      expect(typeof getMilestoneApprovals).toBe('function')
      expect(typeof getApprovedVerifiersCount).toBe('function')
      expect(typeof getAllMilestoneVotes).toBe('function')
      expect(typeof hasVerifierVoted).toBe('function')
      expect(typeof hasMilestoneMetThreshold).toBe('function')
      expect(typeof getMilestoneApprovalProgress).toBe('function')
      expect(typeof resetMilestoneApprovals).toBe('function')
      expect(typeof DuplicateVerifierVoteError).toBe('function')
    })

    it('should properly handle errors', async () => {
      const error = new DuplicateVerifierVoteError('milestone-123', 'verifier-456')
      expect(error.name).toBe('DuplicateVerifierVoteError')
      expect(error.message).toContain('has already voted')
    })
  })
})
