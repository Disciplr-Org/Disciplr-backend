import { parseHorizonEvent, HorizonEvent } from '../services/eventParser.js'

describe('eventParser - Payload Validation', () => {
  describe('vault_created validation', () => {
    it('should validate all required fields for vault_created events', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12345,
        ledgerClosedAt: '2024-01-15T10:30:00Z',
        contractId: 'CDISCIPLR123',
        id: 'abc123-0',
        pagingToken: 'abc123-0',
        topic: ['vault_created'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'abc123'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        // Verify all required fields are present
        expect(payload.vaultId).toBeDefined()
        expect(typeof payload.vaultId).toBe('string')
        
        expect(payload.creator).toBeDefined()
        expect(typeof payload.creator).toBe('string')
        
        expect(payload.amount).toBeDefined()
        expect(typeof payload.amount).toBe('string')
        expect(parseFloat(payload.amount)).not.toBeNaN()
        
        expect(payload.startTimestamp).toBeDefined()
        expect(payload.startTimestamp instanceof Date).toBe(true)
        
        expect(payload.endTimestamp).toBeDefined()
        expect(payload.endTimestamp instanceof Date).toBe(true)
        
        expect(payload.successDestination).toBeDefined()
        expect(typeof payload.successDestination).toBe('string')
        
        expect(payload.failureDestination).toBeDefined()
        expect(typeof payload.failureDestination).toBe('string')
      }
    })
  })

  describe('vault status event validation', () => {
    it('should validate vault_completed event has vaultId and status', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12346,
        ledgerClosedAt: '2024-01-15T10:31:00Z',
        contractId: 'CDISCIPLR123',
        id: 'def456-1',
        pagingToken: 'def456-1',
        topic: ['vault_completed'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'def456'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        expect(payload.vaultId).toBeDefined()
        expect(typeof payload.vaultId).toBe('string')
        
        expect(payload.status).toBeDefined()
        expect(payload.status).toBe('completed')
      }
    })

    it('should validate vault_failed event has vaultId and status', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12347,
        ledgerClosedAt: '2024-01-15T10:32:00Z',
        contractId: 'CDISCIPLR123',
        id: 'ghi789-2',
        pagingToken: 'ghi789-2',
        topic: ['vault_failed'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'ghi789'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        expect(payload.vaultId).toBeDefined()
        expect(typeof payload.vaultId).toBe('string')
        
        expect(payload.status).toBeDefined()
        expect(payload.status).toBe('failed')
      }
    })

    it('should validate vault_cancelled event has vaultId and status', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12348,
        ledgerClosedAt: '2024-01-15T10:33:00Z',
        contractId: 'CDISCIPLR123',
        id: 'jkl012-3',
        pagingToken: 'jkl012-3',
        topic: ['vault_cancelled'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'jkl012'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        expect(payload.vaultId).toBeDefined()
        expect(typeof payload.vaultId).toBe('string')
        
        expect(payload.status).toBeDefined()
        expect(payload.status).toBe('cancelled')
      }
    })
  })

  describe('milestone_created validation', () => {
    it('should validate all required fields for milestone_created events', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12349,
        ledgerClosedAt: '2024-01-15T10:34:00Z',
        contractId: 'CDISCIPLR123',
        id: 'mno345-4',
        pagingToken: 'mno345-4',
        topic: ['milestone_created'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'mno345'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        // Verify all required fields are present
        expect(payload.milestoneId).toBeDefined()
        expect(typeof payload.milestoneId).toBe('string')
        
        expect(payload.vaultId).toBeDefined()
        expect(typeof payload.vaultId).toBe('string')
        
        expect(payload.title).toBeDefined()
        expect(typeof payload.title).toBe('string')
        
        expect(payload.targetAmount).toBeDefined()
        expect(typeof payload.targetAmount).toBe('string')
        expect(parseFloat(payload.targetAmount)).not.toBeNaN()
        
        expect(payload.deadline).toBeDefined()
        expect(payload.deadline instanceof Date).toBe(true)
        expect(isNaN(payload.deadline.getTime())).toBe(false)
      }
    })
  })

  describe('milestone_validated validation', () => {
    it('should validate all required fields for milestone_validated events', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12350,
        ledgerClosedAt: '2024-01-15T10:35:00Z',
        contractId: 'CDISCIPLR123',
        id: 'pqr678-5',
        pagingToken: 'pqr678-5',
        topic: ['milestone_validated'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'pqr678'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        // Verify all required fields are present
        expect(payload.validationId).toBeDefined()
        expect(typeof payload.validationId).toBe('string')
        
        expect(payload.milestoneId).toBeDefined()
        expect(typeof payload.milestoneId).toBe('string')
        
        expect(payload.validatorAddress).toBeDefined()
        expect(typeof payload.validatorAddress).toBe('string')
        
        expect(payload.validationResult).toBeDefined()
        expect(typeof payload.validationResult).toBe('string')
        expect(['approved', 'rejected', 'pending_review']).toContain(payload.validationResult)
        
        expect(payload.validatedAt).toBeDefined()
        expect(payload.validatedAt instanceof Date).toBe(true)
        expect(isNaN(payload.validatedAt.getTime())).toBe(false)
      }
    })
  })

  describe('data type validation', () => {
    it('should validate that amounts are valid decimal numbers', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12351,
        ledgerClosedAt: '2024-01-15T10:36:00Z',
        contractId: 'CDISCIPLR123',
        id: 'stu901-6',
        pagingToken: 'stu901-6',
        topic: ['vault_created'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'stu901'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        // Verify amount is a valid decimal number
        expect(payload.amount).toBeDefined()
        const amountValue = parseFloat(payload.amount)
        expect(amountValue).not.toBeNaN()
        expect(amountValue).toBeGreaterThan(0)
      }
    })

    it('should validate that dates are valid Date objects', () => {
      const mockEvent: HorizonEvent = {
        type: 'contract',
        ledger: 12352,
        ledgerClosedAt: '2024-01-15T10:37:00Z',
        contractId: 'CDISCIPLR123',
        id: 'vwx234-7',
        pagingToken: 'vwx234-7',
        topic: ['milestone_created'],
        value: {
          xdr: 'AAAAAgAAAA...'
        },
        inSuccessfulContractCall: true,
        txHash: 'vwx234'
      }

      const result = parseHorizonEvent(mockEvent)

      expect(result.success).toBe(true)
      if (result.success) {
        const payload = result.event.payload as any
        
        // Verify deadline is a valid Date object
        expect(payload.deadline).toBeDefined()
        expect(payload.deadline instanceof Date).toBe(true)
        expect(isNaN(payload.deadline.getTime())).toBe(false)
      }
    })
  })
})
