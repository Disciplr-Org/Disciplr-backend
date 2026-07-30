import { describe, it, expect } from '@jest/globals'
import { parseHorizonEvent } from '../services/eventParser.js'
import {
  createRawHorizonEvent,
  mockVaultCompletedEvent,
  mockVaultFailedEvent,
  mockVaultCancelledEvent
} from './fixtures/horizonEvents.js'
import type { VaultEventPayload } from '../types/horizonSync.js'

/**
 * Regression coverage for the vault status parsing bug.
 *
 * `parseVaultPayload` validated vault_completed/vault_failed/vault_cancelled
 * payloads but never returned them, so the switch fell through to `default`
 * and returned null. Valid status events therefore failed to parse. These
 * tests prove status events now parse successfully and that the switch no
 * longer falls through to `default` for valid input.
 */
describe('eventParser vault status events', () => {
  const validVaultIds = [
    '550e8400-e29b-41d4-a716-446655440001',
    '550e8400-e29b-41d4-a716-446655440002',
    '550e8400-e29b-41d4-a716-446655440003'
  ]

  const statusFixtures = [
    { fixture: mockVaultCompletedEvent, status: 'completed' as const, vaultId: validVaultIds[0] },
    { fixture: mockVaultFailedEvent, status: 'failed' as const, vaultId: validVaultIds[1] },
    { fixture: mockVaultCancelledEvent, status: 'cancelled' as const, vaultId: validVaultIds[2] }
  ]

  it.each(statusFixtures)(
    'parses a valid $status vault status event',
    ({ fixture, status, vaultId }) => {
      const rawEvent = createRawHorizonEvent(
        fixture.eventType,
        { ...(fixture.payload as unknown as Record<string, unknown>), vaultId },
        { id: `${fixture.transactionHash}-${fixture.eventIndex}`, txHash: fixture.transactionHash, ledger: fixture.ledgerNumber }
      )

      const result = parseHorizonEvent(rawEvent)

      expect(result.success).toBe(true)
      if (!result.success) return

      expect(result.event.eventType).toBe(fixture.eventType)
      const payload = result.event.payload as VaultEventPayload
      expect(payload.vaultId).toBe(vaultId)
      expect(payload.status).toBe(status)
    }
  )

  it('derives the status from the event type when the payload omits it', () => {
    const rawEvent = createRawHorizonEvent('vault_completed', {
      vaultId: '550e8400-e29b-41d4-a716-446655440004'
    })

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(true)
    if (!result.success) return
    const payload = result.event.payload as VaultEventPayload
    expect(payload.status).toBe('completed')
    expect(payload.vaultId).toBe('550e8400-e29b-41d4-a716-446655440004')
  })

  it('rejects a status event with an invalid status value', () => {
    const rawEvent = createRawHorizonEvent('vault_completed', {
      vaultId: '550e8400-e29b-41d4-a716-446655440005',
      status: 'not_a_real_status'
    })

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(false)
    expect(result).toMatchObject({ error: expect.stringContaining('Failed to parse payload') })
  })
})
