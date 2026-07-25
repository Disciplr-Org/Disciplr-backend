import { describe, expect, it } from '@jest/globals'
import { parseHorizonEvent } from '../services/eventParser.js'
import { createRawHorizonEvent } from './fixtures/horizonEvents.js'
import type { ValidationEventPayload, VaultEventPayload } from '../types/horizonSync.js'

const VAULT_ID = '550e8400-e29b-41d4-a716-446655440100'

describe('eventParser deterministic routing and validation', () => {
  it('routes by topic and preserves deterministic Horizon metadata', () => {
    const rawEvent = createRawHorizonEvent(
      'vault_created',
      {
        vaultId: VAULT_ID,
        creator: 'GCREATORADDRESS',
        amount: '1000.0000000',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-02-01T00:00:00.000Z',
        successDestination: 'GSUCCESSDEST',
        failureDestination: 'GFAILUREDEST'
      },
      { id: 'txhashabc-7', txHash: 'txhashabc', ledger: 456 }
    )

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.event.eventId).toBe('txhashabc:7')
    expect(result.event.transactionHash).toBe('txhashabc')
    expect(result.event.eventIndex).toBe(7)
    expect(result.event.ledgerNumber).toBe(456)
    expect(result.event.eventType).toBe('vault_created')
    expect((result.event.payload as VaultEventPayload).vaultId).toBe(VAULT_ID)
  })

  it('maps contract slash topics onto the persisted vault_failed event type', () => {
    const rawEvent = createRawHorizonEvent(
      'vault_failed',
      {
        vaultId: VAULT_ID,
        status: 'failed'
      },
      { topic: ['vault_slashed'] }
    )

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.event.eventType).toBe('vault_failed')
    expect((result.event.payload as VaultEventPayload).status).toBe('failed')
  })

  it('accepts snake_case milestone validation payloads from contract events', () => {
    const rawEvent = createRawHorizonEvent('milestone_validated', {
      validation_id: 'validation-123',
      milestone_id: 'milestone-456',
      validator_address: 'GVALIDATORADDRESS',
      validation_result: 'approved',
      evidence_hash: 'hash-789',
      validated_at: '2026-03-01T12:00:00.000Z'
    })

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(true)
    if (!result.success) return

    const payload = result.event.payload as ValidationEventPayload
    expect(result.event.eventType).toBe('milestone_validated')
    expect(payload.validationId).toBe('validation-123')
    expect(payload.milestoneId).toBe('milestone-456')
    expect(payload.validatorAddress).toBe('GVALIDATORADDRESS')
    expect(payload.validationResult).toBe('approved')
    expect(payload.evidenceHash).toBe('hash-789')
  })

  it('returns a structured parse failure for malformed required payload fields', () => {
    const rawEvent = createRawHorizonEvent('vault_created', {
      vaultId: VAULT_ID,
      amount: '1000.0000000',
      startTimestamp: '2026-01-01T00:00:00.000Z',
      endTimestamp: '2026-02-01T00:00:00.000Z',
      successDestination: 'GSUCCESSDEST',
      failureDestination: 'GFAILUREDEST'
    })

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(false)
    expect(result).toMatchObject({
      error: 'Failed to parse payload for event type: vault_created',
      details: { eventType: 'vault_created' }
    })
  })
})
