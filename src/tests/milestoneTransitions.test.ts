import { describe, it, expect } from '@jest/globals'
import { getTransitionError, validateTransition } from '../services/milestoneTransitions.js'
import type { MilestoneStatus } from '../types/milestone.js'

// ─── getTransitionError ─────────────────────────────────────────────

describe('getTransitionError', () => {
  // ── Valid transitions ───────────────────────────────────────────

  it('allows pending → in_progress', () => {
    expect(getTransitionError('pending', 'in_progress')).toBeNull()
  })

  it('allows in_progress → completed', () => {
    expect(getTransitionError('in_progress', 'completed')).toBeNull()
  })

  it('allows in_progress → failed', () => {
    expect(getTransitionError('in_progress', 'failed')).toBeNull()
  })

  it('allows in_progress → pending (reopen after rejected validation)', () => {
    expect(getTransitionError('in_progress', 'pending')).toBeNull()
  })

  // ── Invalid transitions ─────────────────────────────────────────

  it('rejects pending → completed', () => {
    const error = getTransitionError('pending', 'completed')
    expect(error).toMatch(/Cannot transition from 'pending' to 'completed'/)
  })

  it('rejects pending → failed', () => {
    const error = getTransitionError('pending', 'failed')
    expect(error).toMatch(/Cannot transition from 'pending' to 'failed'/)
  })

  it('rejects pending → pending (no self-transition)', () => {
    const error = getTransitionError('pending', 'pending')
    expect(error).toMatch(/Cannot transition from 'pending' to 'pending'/)
  })

  // ── Terminal status guards ──────────────────────────────────────

  it('rejects completed → any', () => {
    const targets: MilestoneStatus[] = ['pending', 'in_progress', 'completed', 'failed']
    for (const target of targets) {
      const error = getTransitionError('completed', target)
      expect(error).toMatch(/already 'completed'/)
    }
  })

  it('rejects failed → any', () => {
    const targets: MilestoneStatus[] = ['pending', 'in_progress', 'completed', 'failed']
    for (const target of targets) {
      const error = getTransitionError('failed', target)
      expect(error).toMatch(/already 'failed'/)
    }
  })

  // ── Unknown status ──────────────────────────────────────────────

  it('rejects unknown current status', () => {
    const error = getTransitionError('unknown' as MilestoneStatus, 'pending')
    expect(error).toMatch(/Unknown current status/)
  })
})

// ─── validateTransition ─────────────────────────────────────────────

describe('validateTransition', () => {
  it('returns success for valid transition', () => {
    const result = validateTransition('pending', 'in_progress')
    expect(result).toEqual({ success: true })
  })

  it('returns error for invalid transition', () => {
    const result = validateTransition('pending', 'completed')
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('returns error for terminal status', () => {
    const result = validateTransition('completed', 'pending')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already 'completed'/)
  })
})
