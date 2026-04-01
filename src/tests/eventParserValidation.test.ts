import { parseHorizonEvent } from '../services/eventParser.js'
import { createRawHorizonEvent } from './fixtures/horizonEvents.js'

describe('eventParser - Payload Validation', () => {
  it('should validate all required fields for vault_created events', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('vault_created', {
        vaultId: 'vault-123',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        startTimestamp: '2024-01-01T00:00:00.000Z',
        endTimestamp: '2024-12-31T00:00:00.000Z',
        successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
      })
    )

    expect(result.success).toBe(true)
    if (result.success) {
      const payload = result.event.payload as any
      expect(payload.vaultId).toBe('vault-123')
      expect(payload.creator).toBe('GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(payload.amount).toBe('1000.0000000')
      expect(payload.startTimestamp).toEqual(new Date('2024-01-01T00:00:00.000Z'))
      expect(payload.endTimestamp).toEqual(new Date('2024-12-31T00:00:00.000Z'))
      expect(payload.successDestination).toBe('GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(payload.failureDestination).toBe('GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
    }
  })

  it('should validate vault status events from encoded payload fields', () => {
    const completed = parseHorizonEvent(
      createRawHorizonEvent('vault_completed', {
        vaultId: 'vault-complete'
      })
    )
    const failed = parseHorizonEvent(
      createRawHorizonEvent('vault_failed', {
        vaultId: 'vault-failed',
        status: 'failed'
      })
    )
    const cancelled = parseHorizonEvent(
      createRawHorizonEvent('vault_cancelled', {
        vaultId: 'vault-cancelled'
      })
    )

    expect(completed.success).toBe(true)
    expect(failed.success).toBe(true)
    expect(cancelled.success).toBe(true)

    if (completed.success) {
      expect(completed.event.payload).toMatchObject({
        vaultId: 'vault-complete',
        status: 'completed'
      })
    }

    if (failed.success) {
      expect(failed.event.payload).toMatchObject({
        vaultId: 'vault-failed',
        status: 'failed'
      })
    }

    if (cancelled.success) {
      expect(cancelled.event.payload).toMatchObject({
        vaultId: 'vault-cancelled',
        status: 'cancelled'
      })
    }
  })

  it('should validate all required fields for milestone_created events', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('milestone_created', {
        milestoneId: 'milestone-456',
        vaultId: 'vault-456',
        title: 'First Milestone',
        description: 'Complete first task',
        targetAmount: '500.0000000',
        deadline: '2024-06-30T00:00:00.000Z'
      })
    )

    expect(result.success).toBe(true)
    if (result.success) {
      const payload = result.event.payload as any
      expect(payload.milestoneId).toBe('milestone-456')
      expect(payload.vaultId).toBe('vault-456')
      expect(payload.title).toBe('First Milestone')
      expect(payload.targetAmount).toBe('500.0000000')
      expect(payload.deadline).toEqual(new Date('2024-06-30T00:00:00.000Z'))
    }
  })

  it('should validate all required fields for milestone_validated events', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('milestone_validated', {
        validationId: 'validation-789',
        milestoneId: 'milestone-789',
        validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        validationResult: 'pending_review',
        evidenceHash: 'hash-abc123def456',
        validatedAt: '2024-03-15T10:30:00.000Z'
      })
    )

    expect(result.success).toBe(true)
    if (result.success) {
      const payload = result.event.payload as any
      expect(payload.validationId).toBe('validation-789')
      expect(payload.milestoneId).toBe('milestone-789')
      expect(payload.validatorAddress).toBe('GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(payload.validationResult).toBe('pending_review')
      expect(payload.validatedAt).toEqual(new Date('2024-03-15T10:30:00.000Z'))
    }
  })

  it('should reject encoded payloads with missing required fields', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('milestone_created', {
        milestoneId: 'milestone-invalid',
        vaultId: 'vault-invalid',
        description: 'Missing title and target amount',
        deadline: '2024-06-30T00:00:00.000Z'
      })
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to parse payload')
    }
  })

  it('should reject invalid decimal and date values without throwing', () => {
    const invalidAmountResult = parseHorizonEvent(
      createRawHorizonEvent('vault_created', {
        vaultId: 'vault-invalid-amount',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: 'not-a-number',
        startTimestamp: '2024-01-01T00:00:00.000Z',
        endTimestamp: '2024-12-31T00:00:00.000Z',
        successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
      })
    )

    const invalidDateResult = parseHorizonEvent(
      createRawHorizonEvent('milestone_validated', {
        validationId: 'validation-invalid-date',
        milestoneId: 'milestone-invalid-date',
        validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        validationResult: 'approved',
        evidenceHash: 'hash-invalid-date',
        validatedAt: 'not-a-date'
      })
    )

    expect(invalidAmountResult.success).toBe(false)
    expect(invalidDateResult.success).toBe(false)
  })
})
