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
  const statusFixtures = [
    { fixture: mockVaultCompletedEvent, status: 'completed' as const },
    { fixture: mockVaultFailedEvent, status: 'failed' as const },
    { fixture: mockVaultCancelledEvent, status: 'cancelled' as const }
  ]

  it.each(statusFixtures)(
    'parses a valid $status vault status event',
    ({ fixture, status }) => {
      const rawEvent = createRawHorizonEvent(
        fixture.eventType,
        fixture.payload as Record<string, unknown>,
        { id: `${fixture.transactionHash}-${fixture.eventIndex}`, txHash: fixture.transactionHash, ledger: fixture.ledgerNumber }
      )

      const result = parseHorizonEvent(rawEvent)

      expect(result.success).toBe(true)
      if (!result.success) return

      expect(result.event.eventType).toBe(fixture.eventType)
      const payload = result.event.payload as VaultEventPayload
      expect(payload.vaultId).toBe((fixture.payload as VaultEventPayload).vaultId)
      expect(payload.status).toBe(status)
    }
  )

  it('derives the status from the event type when the payload omits it', () => {
    const rawEvent = createRawHorizonEvent('vault_completed', {
      vaultId: 'vault-no-status'
    })

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(true)
    if (!result.success) return
    const payload = result.event.payload as VaultEventPayload
    expect(payload.status).toBe('completed')
    expect(payload.vaultId).toBe('vault-no-status')
  })

  it('rejects a status event with an invalid status value', () => {
    const rawEvent = createRawHorizonEvent('vault_completed', {
      vaultId: 'vault-bad-status',
      status: 'not_a_real_status'
    })

    const result = parseHorizonEvent(rawEvent)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('Failed to parse payload')
  })
})
