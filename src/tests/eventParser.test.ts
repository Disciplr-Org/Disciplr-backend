import { parseHorizonEvent } from '../services/eventParser.js'
import { createRawHorizonEvent } from './fixtures/horizonEvents.js'

jest.mock('@stellar/stellar-sdk', () => ({
  xdr: {
    ScVal: {
      fromXDR: jest.fn().mockReturnValue({})
    }
  },
  scValToNative: jest.fn().mockImplementation((val) => {
    // Return a sensible default based on common testing needs or just a dynamic object
    return {
      vault_id: 'vault-test-001',
      creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      amount: '1000.0000000',
      start_date: Math.floor(Date.now() / 1000),
      end_date: Math.floor(Date.now() / 1000) + 86400,
      success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      status: 'active',
      milestone_id: 'milestone-test-001',
      title: 'Test Milestone',
      due_date: Math.floor(Date.now() / 1000) + 86400,
      validation_id: 'validation-test-001',
      validator: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      result: 'approved',
      timestamp: Math.floor(Date.now() / 1000)
    }
  })
}))

describe('eventParser', () => {
  describe('parseHorizonEvent', () => {
    it('should parse vault_created event payload fields from encoded payload data', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('vault_created', {
          vaultId: 'vault-001',
          creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: '1000.0000000',
          startTimestamp: '2024-01-01T00:00:00.000Z',
          endTimestamp: '2024-12-31T00:00:00.000Z',
          successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          status: 'active'
        }, {
          txHash: 'abc123',
          id: 'abc123-0',
          ledger: 12345
        })
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.event.eventType).toBe('vault_created')
        expect(result.event.eventId).toBe('abc123:0')
        expect(result.event.transactionHash).toBe('abc123')
        expect(result.event.eventIndex).toBe(0)
        expect(result.event.ledgerNumber).toBe(12345)
        expect(result.event.payload).toMatchObject({
          vaultId: 'vault-001',
          creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: '1000.0000000',
          successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          status: 'active'
        })
        expect((result.event.payload as any).startTimestamp).toEqual(new Date('2024-01-01T00:00:00.000Z'))
        expect((result.event.payload as any).endTimestamp).toEqual(new Date('2024-12-31T00:00:00.000Z'))
      }
    })

    it('should parse vault_completed event and default status to the topic value', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('vault_completed', {
          vaultId: 'vault-002'
        }, {
          txHash: 'def456',
          id: 'def456-1',
          ledger: 12346
        })
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.event.eventType).toBe('vault_completed')
        expect(result.event.payload).toMatchObject({
          vaultId: 'vault-002',
          status: 'completed'
        })
      }
    })

    it('should parse milestone_created event and decode deadline into a Date', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('milestone_created', {
          milestoneId: 'milestone-003',
          vaultId: 'vault-003',
          title: 'Launch',
          description: 'Ship the first release',
          targetAmount: '500.0000000',
          deadline: '2024-06-30T00:00:00.000Z'
        }, {
          txHash: 'ghi789',
          id: 'ghi789-2',
          ledger: 12347
        })
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.event.eventType).toBe('milestone_created')
        expect(result.event.payload).toMatchObject({
          milestoneId: 'milestone-003',
          vaultId: 'vault-003',
          title: 'Launch',
          description: 'Ship the first release',
          targetAmount: '500.0000000'
        })
        expect((result.event.payload as any).deadline).toEqual(new Date('2024-06-30T00:00:00.000Z'))
      }
    })

    it('should parse milestone_validated event payload fields from encoded payload data', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('milestone_validated', {
          validationId: 'validation-004',
          milestoneId: 'milestone-004',
          validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          validationResult: 'approved',
          evidenceHash: 'hash-abc123',
          validatedAt: '2024-03-15T10:30:00.000Z'
        }, {
          txHash: 'jkl012',
          id: 'jkl012-3',
          ledger: 12348
        })
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.event.eventType).toBe('milestone_validated')
        expect(result.event.payload).toMatchObject({
          validationId: 'validation-004',
          milestoneId: 'milestone-004',
          validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          validationResult: 'approved',
          evidenceHash: 'hash-abc123'
        })
        expect((result.event.payload as any).validatedAt).toEqual(new Date('2024-03-15T10:30:00.000Z'))
      }
    })

    it('should return error for unknown event type', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('vault_created', {
          vaultId: 'vault-unknown'
        }, {
          txHash: 'mno345',
          id: 'mno345-4',
          topic: ['unknown_event']
        })
      )

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Unknown event type')
      }
    })

    it('should return error for malformed encoded payload data', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('vault_created', {
          vaultId: 'vault-bad'
        }, {
          txHash: 'bad001',
          id: 'bad001-0',
          value: {
            xdr: 'not-json-and-not-valid-encoded-payload'
          }
        })
      )

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Failed to parse payload')
      }
    })

    it('should return error for missing transaction hash', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('vault_created', {
          vaultId: 'vault-no-hash'
        }, {
          txHash: '',
          id: 'pqr678-5'
        })
      )

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Missing transaction hash')
      }
    })

    it('should return error for missing event topic', () => {
      const result = parseHorizonEvent(
        createRawHorizonEvent('vault_created', {
          vaultId: 'vault-no-topic'
        }, {
          txHash: 'stu901',
          id: 'stu901-6',
          topic: []
        })
      )

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Missing event topic')
      }
    })
  })
})
