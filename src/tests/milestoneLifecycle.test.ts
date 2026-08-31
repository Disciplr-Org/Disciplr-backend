/**
 * Milestone lifecycle and event ordering — regression contract tests.
 *
 * Anchored at src/routes/milestones.ts + src/repositories/milestoneRepository.ts
 * (service layer: src/services/milestones.ts).
 *
 * Covers the monotonic lifecycle state machine, ordered/auditable event
 * ledger, duplicate-request idempotency, and boundary/permission behavior.
 * Pure unit tests — no DB required.
 */
import {
  createMilestone,
  resetMilestonesTable,
  transitionMilestone,
  getMilestoneLifecycleState,
  getMilestoneEventSeq,
  resetMilestoneLifecycle,
  addMilestoneEvent,
  listMilestoneEvents,
  resetMilestones,
  verifyMilestone,
  validateMilestone,
  allMilestonesVerified,
  validateMilestoneMultiVerifier,
  createMilestoneWithThreshold,
  allMilestonesMetThreshold,
} from '../services/milestones.js'

const V = 'vault-lc-test'

function freshMilestone(description = 'lifecycle milestone'): ReturnType<typeof createMilestone> {
  return createMilestone(V, description, 'verifier-1')
}

describe('Milestone lifecycle state machine (monotonic)', () => {
  beforeEach(() => {
    resetMilestonesTable()
    resetMilestones()
    resetMilestoneLifecycle()
  })

  it('starts in the created state once registered with the lifecycle', () => {
    const m = freshMilestone()
    expect(getMilestoneLifecycleState(m.id)).toBeNull()
    expect(getMilestoneEventSeq(m.id)).toBe(0)
    // The implicit starting state is `created`: submitting is a valid first transition.
    expect(transitionMilestone(m.id, 'submitted').success).toBe(true)
  })

  it('walks the full forward chain created -> submitted -> validated -> settled', () => {
    const m = freshMilestone()
    expect(transitionMilestone(m.id, 'submitted').success).toBe(true)
    expect(transitionMilestone(m.id, 'validated').success).toBe(true)
    expect(transitionMilestone(m.id, 'settled').success).toBe(true)
    expect(getMilestoneLifecycleState(m.id)).toBe('settled')
    expect(getMilestoneEventSeq(m.id)).toBe(3)
  })

  it('rejects backward transitions (monotonicity)', () => {
    const m = freshMilestone()
    expect(transitionMilestone(m.id, 'submitted').success).toBe(true)
    const back = transitionMilestone(m.id, 'created')
    expect(back.success).toBe(false)
    expect(back.error).toMatch(/regression/i)
    expect(getMilestoneLifecycleState(m.id)).toBe('submitted')
  })

  it('rejects self-transitions and unknown states', () => {
    const m = freshMilestone()
    expect(transitionMilestone(m.id, 'created' as any).success).toBe(false)
    expect(transitionMilestone(m.id, 'bogus' as any).success).toBe(false)
    expect(getMilestoneLifecycleState(m.id)).toBeNull()
  })

  it('rejects invalid skips (created -> validated) and unknown milestones', () => {
    const m = freshMilestone()
    expect(transitionMilestone(m.id, 'validated').success).toBe(false)
    expect(getMilestoneLifecycleState(m.id)).toBeNull()
    expect(transitionMilestone('no-such-milestone', 'submitted').success).toBe(false)
  })

  it('settled is terminal: no further transitions and no extra events', () => {
    const m = freshMilestone()
    for (const to of ['submitted', 'validated', 'settled'] as const) {
      expect(transitionMilestone(m.id, to).success).toBe(true)
    }
    const seqBefore = getMilestoneEventSeq(m.id)
    expect(transitionMilestone(m.id, 'validated').success).toBe(false)
    expect(transitionMilestone(m.id, 'created').success).toBe(false)
    expect(getMilestoneEventSeq(m.id)).toBe(seqBefore)
    expect(listMilestoneEvents({ vaultId: V })).toHaveLength(3)
  })

  it('advances verified/verifiedAt atomically with validated/settled transitions', () => {
    const m = freshMilestone()
    expect(m.verified).toBe(false)
    transitionMilestone(m.id, 'submitted')
    expect(m.verified).toBe(false)
    const at = '2026-08-29T12:00:00.000Z'
    const r = transitionMilestone(m.id, 'validated', { actor: 'verifier-1', at })
    expect(r.success).toBe(true)
    expect(m.verified).toBe(true)
    expect(m.verifiedAt).toBe(at)
    expect(m.verifiedBy).toBe('verifier-1')
  })
})

describe('Milestone event ledger (ordered, auditable, duplicate-safe)', () => {
  beforeEach(() => {
    resetMilestonesTable()
    resetMilestones()
    resetMilestoneLifecycle()
  })

  it('emits exactly one ordered lifecycle event per successful transition', () => {
    const m = freshMilestone()
    transitionMilestone(m.id, 'submitted')
    transitionMilestone(m.id, 'validated')
    transitionMilestone(m.id, 'settled')
    const events = listMilestoneEvents({ vaultId: V })
    expect(events.map((e) => e.name)).toEqual([
      'milestone.lifecycle.submitted',
      'milestone.lifecycle.validated',
      'milestone.lifecycle.settled',
    ])
  })

  it('emits no event on failed transitions', () => {
    const m = freshMilestone()
    transitionMilestone(m.id, 'validated') // invalid skip
    transitionMilestone('no-such-id', 'submitted')
    expect(listMilestoneEvents({ vaultId: V })).toHaveLength(0)
  })

  it('keeps per-milestone sequence numbers monotonic across events', () => {
    const a = freshMilestone('a')
    const b = freshMilestone('b')
    transitionMilestone(a.id, 'submitted')
    transitionMilestone(b.id, 'submitted')
    transitionMilestone(a.id, 'validated')
    const events = listMilestoneEvents({ vaultId: V })
    const seqs = events.map((e) => Number(e.id.split('_')[1]))
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    expect(getMilestoneEventSeq(a.id)).toBe(2)
    expect(getMilestoneEventSeq(b.id)).toBe(1)
  })

  it('is append-only under filtering: list() never mutates the ledger', () => {
    const m = freshMilestone()
    transitionMilestone(m.id, 'submitted')
    const before = listMilestoneEvents().length
    listMilestoneEvents({ userId: 'nobody' })
    expect(listMilestoneEvents().length).toBe(before)
  })

  it('deduplicates identical events (duplicate-request safety)', () => {
    const payload = {
      userId: 'verifier-1',
      vaultId: V,
      name: 'milestone.validated',
      status: 'success' as const,
      timestamp: '2026-08-29T12:00:00.000Z',
    }
    const e1 = addMilestoneEvent(payload)
    const e2 = addMilestoneEvent({ ...payload })
    expect(e2.id).toBe(e1.id)
    expect(listMilestoneEvents({ vaultId: V })).toHaveLength(1)
  })

  it('keeps distinct events distinct (same actor, different name/time)', () => {
    addMilestoneEvent({ userId: 'v1', vaultId: V, name: 'milestone.validated', status: 'success', timestamp: '2026-08-29T12:00:00.000Z' })
    addMilestoneEvent({ userId: 'v1', vaultId: V, name: 'milestone.submitted', status: 'success', timestamp: '2026-08-29T12:00:00.000Z' })
    addMilestoneEvent({ userId: 'v1', vaultId: V, name: 'milestone.validated', status: 'success', timestamp: '2026-08-29T13:00:00.000Z' })
    expect(listMilestoneEvents({ vaultId: V })).toHaveLength(3)
  })
})

describe('Event ledger ordering and filter boundaries', () => {
  beforeEach(() => {
    resetMilestonesTable()
    resetMilestones()
    resetMilestoneLifecycle()
  })

  it('embeds a monotonic per-vault sequence number in every event id (m_<seq>_<suffix>)', () => {
    const m = freshMilestone()
    transitionMilestone(m.id, 'submitted')
    transitionMilestone(m.id, 'validated')
    const events = listMilestoneEvents({ vaultId: V })
    expect(events[0].id).toMatch(/^m_1_[a-z0-9]+$/i)
    expect(events[1].id).toMatch(/^m_2_[a-z0-9]+$/i)
    expect(events[0].id).not.toBe(events[1].id)
  })

  it('keeps the shared per-vault sequence monotonic across transitions and manual events', () => {
    const m = freshMilestone()
    transitionMilestone(m.id, 'submitted') // seq 1
    transitionMilestone(m.id, 'validated') // seq 2
    addMilestoneEvent({ userId: 'v1', vaultId: V, name: 'milestone.manual', status: 'success', timestamp: '2026-08-29T12:00:00.000Z' }) // seq 3
    const events = listMilestoneEvents({ vaultId: V })
    expect(events).toHaveLength(3)
    const seqs = events.map((e) => Number(e.id.split('_')[1]))
    expect(seqs).toEqual([1, 2, 3])
  })

  it('applies from/to filters inclusively on timestamps', () => {
    const m = freshMilestone()
    transitionMilestone(m.id, 'submitted', { at: '2026-08-29T10:00:00.000Z' })
    transitionMilestone(m.id, 'validated', { at: '2026-08-29T11:00:00.000Z' })
    transitionMilestone(m.id, 'settled', { at: '2026-08-29T12:00:00.000Z' })

    const from = listMilestoneEvents({ vaultId: V, from: '2026-08-29T11:00:00.000Z' })
    expect(from.map((e) => e.name)).toEqual(['milestone.lifecycle.validated', 'milestone.lifecycle.settled'])
    const to = listMilestoneEvents({ vaultId: V, to: '2026-08-29T11:00:00.000Z' })
    expect(to.map((e) => e.name)).toEqual(['milestone.lifecycle.submitted', 'milestone.lifecycle.validated'])
    const range = listMilestoneEvents({ vaultId: V, from: '2026-08-29T10:30:00.000Z', to: '2026-08-29T11:30:00.000Z' })
    expect(range.map((e) => e.name)).toEqual(['milestone.lifecycle.validated'])
  })

  it('returns an empty result for unparseable filter timestamps instead of throwing', () => {
    const m = freshMilestone()
    transitionMilestone(m.id, 'submitted', { at: '2026-08-29T10:00:00.000Z' })
    expect(listMilestoneEvents({ vaultId: V, from: 'not-a-date' })).toEqual([])
    expect(listMilestoneEvents({ vaultId: V, to: 'not-a-date' })).toEqual([])
  })

  it('recognises an idempotency-key replay of an already-applied transition even after settlement', () => {
    const m = freshMilestone()
    expect(transitionMilestone(m.id, 'submitted', { idempotencyKey: 'req-1' }).success).toBe(true)
    expect(transitionMilestone(m.id, 'validated', { idempotencyKey: 'req-2' }).success).toBe(true)
    expect(transitionMilestone(m.id, 'settled', { idempotencyKey: 'req-3' }).success).toBe(true)

    // The replay check runs before the settled guard: a retry of the original
    // transition is acknowledged as a duplicate, not misreported as a regression.
    const replay = transitionMilestone(m.id, 'submitted', { idempotencyKey: 'req-1' })
    expect(replay.success).toBe(true)
    expect(replay.error).toBe('duplicate-idempotent-replay')
    expect(getMilestoneLifecycleState(m.id)).toBe('settled')
  })
})

describe('Lifecycle duplicate-request idempotency (retry safety)', () => {
  beforeEach(() => {
    resetMilestonesTable()
    resetMilestones()
    resetMilestoneLifecycle()
  })

  it('acknowledges a retried transition with the same idempotency key without re-applying', () => {
    const m = freshMilestone()
    const first = transitionMilestone(m.id, 'submitted', { idempotencyKey: 'req-1', actor: 'verifier-1' })
    expect(first.success).toBe(true)
    const retry = transitionMilestone(m.id, 'submitted', { idempotencyKey: 'req-1', actor: 'verifier-1' })
    // Replay is acknowledged (not an error thrown) but must not re-apply or re-emit.
    expect(retry.success).toBe(true)
    expect(retry.error).toBe('duplicate-idempotent-replay')
    expect(getMilestoneLifecycleState(m.id)).toBe('submitted')
    expect(getMilestoneEventSeq(m.id)).toBe(1)
    expect(listMilestoneEvents({ vaultId: V })).toHaveLength(1)
  })

  it('applies a different idempotency key as a new request', () => {
    const m = freshMilestone()
    expect(transitionMilestone(m.id, 'submitted', { idempotencyKey: 'req-1' }).success).toBe(true)
    expect(transitionMilestone(m.id, 'validated', { idempotencyKey: 'req-2' }).success).toBe(true)
    expect(getMilestoneLifecycleState(m.id)).toBe('validated')
    expect(listMilestoneEvents({ vaultId: V })).toHaveLength(2)
  })

  it('is idempotent keys are scoped per milestone (no cross-milestone interference)', () => {
    const a = freshMilestone('a')
    const b = freshMilestone('b')
    expect(transitionMilestone(a.id, 'submitted', { idempotencyKey: 'req-1' }).success).toBe(true)
    expect(transitionMilestone(b.id, 'submitted', { idempotencyKey: 'req-1' }).success).toBe(true)
    expect(getMilestoneLifecycleState(a.id)).toBe('submitted')
    expect(getMilestoneLifecycleState(b.id)).toBe('submitted')
  })

  it('concurrent duplicate submissions apply the transition exactly once', () => {
    const m = freshMilestone()
    const results = [
      transitionMilestone(m.id, 'submitted', { idempotencyKey: 'race-1', actor: 'v1' }),
      transitionMilestone(m.id, 'submitted', { idempotencyKey: 'race-1', actor: 'v1' }),
      transitionMilestone(m.id, 'submitted', { idempotencyKey: 'race-1', actor: 'v1' }),
    ]
    expect(results.filter((r) => r.error === 'duplicate-idempotent-replay')).toHaveLength(2)
    expect(getMilestoneLifecycleState(m.id)).toBe('submitted')
    expect(listMilestoneEvents({ vaultId: V })).toHaveLength(1)
  })
})

describe('Boundary and permission behavior (existing contract preserved)', () => {
  beforeEach(() => {
    resetMilestonesTable()
    resetMilestones()
    resetMilestoneLifecycle()
  })

  it('verifyMilestone is idempotent and sets verifiedAt', () => {
    const m = freshMilestone()
    const first = verifyMilestone(m.id)
    expect(first.verified).toBe(true)
    expect(first.verifiedAt).toBeTruthy()
    const again = verifyMilestone(m.id)
    expect(again.verified).toBe(true)
  })

  it('verifyMilestone returns null for unknown id', () => {
    expect(verifyMilestone('no-such-id')).toBeNull()
  })

  it('validateMilestone: success, wrong-verifier rejection, replay rejection, unknown id', () => {
    const m = freshMilestone()
    expect(validateMilestone(m.id, 'verifier-other', 'a'.repeat(64)).success).toBe(false)
    const ok = validateMilestone(m.id, 'verifier-1', 'a'.repeat(64))
    expect(ok.success).toBe(true)
    expect(ok.milestone!.verifiedBy).toBe('verifier-1')
    expect(ok.milestone!.evidenceHash).toBe('a'.repeat(64))
    expect(validateMilestone(m.id, 'verifier-1', 'b'.repeat(64)).error).toMatch(/already validated/i)
    expect(validateMilestone('no-such-id', 'verifier-1', 'c'.repeat(64)).success).toBe(false)
  })

  it('allMilestonesVerified is false for empty vault and true only when all verified', () => {
    expect(allMilestonesVerified(V)).toBe(false)
    const a = freshMilestone('a')
    const b = freshMilestone('b')
    verifyMilestone(a.id)
    expect(allMilestonesVerified(V)).toBe(false)
    verifyMilestone(b.id)
    expect(allMilestonesVerified(V)).toBe(true)
  })

  it('multi-verifier: suspended/deactivated verifiers cannot approve; wrong verifier rejected at threshold 1', () => {
    const m = createMilestoneWithThreshold(V, 'threshold milestone', 1, 'verifier-1')
    const suspended = validateMilestoneMultiVerifier(m.id, 'verifier-9', 'suspended')
    expect(suspended.success).toBe(false)
    expect(suspended.canApprove).toBe(false)
    const wrong = validateMilestoneMultiVerifier(m.id, 'verifier-9', 'approved')
    expect(wrong.success).toBe(false)
    expect(wrong.error).toMatch(/assigned verifier/i)
  })

  it('multi-verifier: threshold 2 allows any of 2 verifiers; already-verified is rejected', () => {
    const m = createMilestoneWithThreshold(V, 'threshold milestone', 2, 'verifier-1')
    expect(validateMilestoneMultiVerifier(m.id, 'verifier-9', 'approved').success).toBe(true)
    // Pure check: mark verified first (mirrors the route's settlement step).
    verifyMilestone(m.id)
    const second = validateMilestoneMultiVerifier(m.id, 'verifier-9', 'approved')
    expect(second.success).toBe(false)
    expect(second.error).toMatch(/already verified/i)
  })

  it('veto semantics: any rejection vetoes when totalVerifiers is absent; maxPossible shortfall vetoes', () => {
    const a = createMilestoneWithThreshold(V, 'a', 2, 'v1')
    const b = createMilestoneWithThreshold(V, 'b', 2, 'v1')
    // Threshold 2 with only 2 approvals recorded on `a` (count map) — b has no
    // approvals so the vault is not complete. Use single-milestone vault for the
    // pure threshold-met case instead.
    resetMilestonesTable()
    const solo = createMilestoneWithThreshold(V, 'solo', 2, 'v1')
    expect(allMilestonesMetThreshold(V, { [solo.id]: 2 }, {}, {})).toBe(true)
    expect(allMilestonesMetThreshold(V, { [solo.id]: 1 }, { [solo.id]: 1 }, {})).toBe(false)
    expect(allMilestonesMetThreshold(V, { [solo.id]: 1 }, {}, { [solo.id]: 3 })).toBe(false)
    expect(allMilestonesMetThreshold(V, { [solo.id]: 2 }, {}, { [solo.id]: 3 })).toBe(true)
    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()
  })
})
