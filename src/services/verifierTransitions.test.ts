import {
  assertVerifierLifecycleTransition,
  authorizeVerifierQueueAction,
  VerifierAuthorizationError,
} from './verifierTransitions.js'
import { describe, expect, it } from '@jest/globals'

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'ms-1498-test',
  verifierId: 'verifier-1',
  approvalThreshold: 1,
  verified: false,
  ...overrides,
})

const expectAuthorizationError = (
  action: 'verify' | 'validate' | 'approve',
  queueItem: Record<string, unknown>,
  actor: unknown,
  code: string,
) => {
  try {
    authorizeVerifierQueueAction(queueItem, actor, action)
    throw new Error('expected authorization to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(VerifierAuthorizationError)
    expect((error as VerifierAuthorizationError).code).toBe(code)
    expect((error as VerifierAuthorizationError).action).toBe(action)
    expect((error as VerifierAuthorizationError).itemId).toBe('ms-1498-test')
  }
}

describe('verifier queue authorization', () => {
  it.each(['verify', 'validate', 'approve'] as const)(
    'allows the current assignee to %s a single-verifier item',
    (action) => {
      expect(() => authorizeVerifierQueueAction(item(), 'verifier-1', action)).not.toThrow()
    },
  )

  it.each(['verify', 'validate', 'approve'] as const)(
    'rejects an empty actor before any queue action (%s)',
    (action) => {
      expectAuthorizationError(action, item(), '', 'ACTOR_REQUIRED')
      expectAuthorizationError(action, item(), null, 'ACTOR_REQUIRED')
      expectAuthorizationError(action, item(), 42, 'ACTOR_REQUIRED')
    },
  )

  it.each(['verify', 'validate', 'approve'] as const)(
    'rejects an unassigned single-verifier queue item (%s)',
    (action) => {
      expectAuthorizationError(action, item({ verifierId: null }), 'verifier-1', 'UNASSIGNED_QUEUE_ITEM')
      expectAuthorizationError(action, item({ verifierId: '' }), 'verifier-1', 'UNASSIGNED_QUEUE_ITEM')
      expectAuthorizationError(action, item({ verifierId: undefined }), 'verifier-1', 'UNASSIGNED_QUEUE_ITEM')
    },
  )

  it.each(['verify', 'validate', 'approve'] as const)(
    'rejects a stale actor after reassignment (%s)',
    (action) => {
      const reassigned = item({ verifierId: 'verifier-2' })
      expectAuthorizationError(action, reassigned, 'verifier-1', 'STALE_ASSIGNMENT')
      expect(() => authorizeVerifierQueueAction(reassigned, 'verifier-2', action)).not.toThrow()
    },
  )

  it('permits approved pool members on an explicitly multi-verifier queue', () => {
    const multi = item({ verifierId: 'verifier-coordinator', approvalThreshold: 2 })
    expect(() => authorizeVerifierQueueAction(multi, 'verifier-1', 'approve')).not.toThrow()
    expect(() => authorizeVerifierQueueAction(multi, 'verifier-2', 'approve')).not.toThrow()
  })

  it('does not broaden verification or validation for multi-verifier queues', () => {
    const multi = item({ verifierId: 'verifier-coordinator', approvalThreshold: 2 })
    expectAuthorizationError('verify', multi, 'verifier-1', 'STALE_ASSIGNMENT')
    expectAuthorizationError('validate', multi, 'verifier-1', 'STALE_ASSIGNMENT')
  })

  it('rejects settled queue items before a second verification transition', () => {
    expectAuthorizationError('verify', item({ verified: true }), 'verifier-1', 'ALREADY_SETTLED')
    expectAuthorizationError('validate', item({ verified: true }), 'verifier-1', 'ALREADY_SETTLED')
  })
})

describe('verifier lifecycle transition contract', () => {
  it('allows each forward transition for the current assignee', () => {
    expect(() => assertVerifierLifecycleTransition(item(), 'verifier-1', 'validate', 'created', 'submitted')).not.toThrow()
    expect(() => assertVerifierLifecycleTransition(item(), 'verifier-1', 'validate', 'submitted', 'validated')).not.toThrow()
    expect(() => assertVerifierLifecycleTransition(item(), 'verifier-1', 'approve', 'validated', 'settled')).not.toThrow()
  })

  it.each([
    ['created', 'created'],
    ['created', 'validated'],
    ['submitted', 'submitted'],
    ['submitted', 'settled'],
    ['validated', 'submitted'],
    ['settled', 'validated'],
  ] as const)('rejects invalid transition %s -> %s without mutation', (from, to) => {
    try {
      assertVerifierLifecycleTransition(item(), 'verifier-1', 'validate', from, to)
      throw new Error('expected transition to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(VerifierAuthorizationError)
      expect((error as VerifierAuthorizationError).code).toBe('INVALID_TRANSITION')
    }
  })

  it('checks authorization before transition validity so stale work cannot probe state', () => {
    expect(() => assertVerifierLifecycleTransition(
      item({ verifierId: 'verifier-2' }),
      'verifier-1',
      'validate',
      'settled',
      'created' as never,
    )).toThrow(/currently assigned verifier/i)
  })
})

describe('error shape', () => {
  it('keeps stable machine-readable details for API adapters', () => {
    try {
      authorizeVerifierQueueAction(item({ verifierId: null }), 'verifier-1', 'validate')
    } catch (error) {
      const typed = error as VerifierAuthorizationError
      expect(typed.name).toBe('VerifierAuthorizationError')
      expect(typed.code).toBe('UNASSIGNED_QUEUE_ITEM')
      expect(typed.action).toBe('validate')
      expect(typed.itemId).toBe('ms-1498-test')
      expect(typed.message).toMatch(/not assigned/i)
    }
  })
})

describe('queue boundary invariants', () => {
  it('trims actor identity but never trims or normalizes the stored assignment', () => {
    expect(() => authorizeVerifierQueueAction(item(), ' verifier-1 ', 'validate')).not.toThrow()
    expectAuthorizationError('validate', item({ verifierId: 'verifier-1 ' }), 'verifier-1', 'STALE_ASSIGNMENT')
  })

  it('treats malformed approval thresholds as single-verifier work', () => {
    for (const approvalThreshold of [0, -1, 1.5, Number.NaN, '2']) {
      expectAuthorizationError(
        'approve',
        item({ approvalThreshold, verifierId: null }),
        'verifier-1',
        'UNASSIGNED_QUEUE_ITEM',
      )
    }
  })

  it('does not mutate a queue item during any authorization decision', () => {
    const queueItem = item()
    const before = { ...queueItem }
    expect(() => authorizeVerifierQueueAction(queueItem, 'verifier-1', 'verify')).not.toThrow()
    expect(() => authorizeVerifierQueueAction(queueItem, 'verifier-2', 'validate')).toThrow()
    expect(queueItem).toEqual(before)
  })

  it('keeps the multi-verifier exception limited to approval actions', () => {
    const queueItem = item({ approvalThreshold: 3, verifierId: null })
    expect(() => authorizeVerifierQueueAction(queueItem, 'verifier-9', 'approve')).not.toThrow()
    expectAuthorizationError('verify', queueItem, 'verifier-9', 'UNASSIGNED_QUEUE_ITEM')
    expectAuthorizationError('validate', queueItem, 'verifier-9', 'UNASSIGNED_QUEUE_ITEM')
  })

  it('rejects duplicate and skipped state edges for a stale actor without exposing them as valid', () => {
    const queueItem = item({ verifierId: 'verifier-2' })
    for (const [from, to] of [
      ['created', 'created'],
      ['created', 'validated'],
      ['submitted', 'settled'],
      ['validated', 'submitted'],
    ] as const) {
      expect(() => assertVerifierLifecycleTransition(
        queueItem,
        'verifier-1',
        'validate',
        from,
        to as 'submitted' | 'validated' | 'settled',
      )).toThrow(/currently assigned verifier/i)
    }
  })

  it('permits only the documented lifecycle edges after authorization', () => {
    const queueItem = item()
    const edges = [
      ['created', 'submitted'],
      ['submitted', 'validated'],
      ['validated', 'settled'],
    ] as const
    for (const [from, to] of edges) {
      expect(() => assertVerifierLifecycleTransition(
        queueItem,
        'verifier-1',
        to === 'settled' ? 'approve' : 'validate',
        from,
        to,
      )).not.toThrow()
    }
  })
})
