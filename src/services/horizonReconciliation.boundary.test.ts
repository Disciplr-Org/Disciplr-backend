import { jest } from '@jest/globals'
import {
  HorizonReconciler,
  isValidObservation,
  filterValidObservations,
  validateScanWindow,
  canApplyObservedStatus,
  statusRank,
  ReconciliationValidationError,
  type HorizonObservation,
  type HorizonObservationSource,
} from './horizonReconciliation.js'

describe('Horizon Reconciliation — Boundary & Adversarial Invariant Tests', () => {
  const validObservation: HorizonObservation = {
    eventId: 'evt-valid-1',
    contractAddress: 'CCONTRACT1',
    vaultId: '00000000-0000-0000-0000-000000000001',
    transactionHash: '3389e9f0f73b404b45dc55b18382315cb49ac9f2d5feb686ed97f08917546761',
    ledgerNumber: 150,
    pagingToken: '150-0',
    eventType: 'vault_completed',
    status: 'completed',
    payload: { amount: '100', reason: 'success' },
  }

  describe('isValidObservation', () => {
    it('returns true for valid observations', () => {
      expect(isValidObservation(validObservation)).toBe(true)
    })

    it('rejects missing or empty eventId', () => {
      expect(isValidObservation({ ...validObservation, eventId: '' })).toBe(false)
      expect(isValidObservation({ ...validObservation, eventId: '  ' })).toBe(false)
      expect(isValidObservation({ ...validObservation, eventId: undefined })).toBe(false)
    })

    it('rejects missing or empty contractAddress', () => {
      expect(isValidObservation({ ...validObservation, contractAddress: '' })).toBe(false)
      expect(isValidObservation({ ...validObservation, contractAddress: undefined })).toBe(false)
    })

    it('rejects missing or empty vaultId', () => {
      expect(isValidObservation({ ...validObservation, vaultId: '' })).toBe(false)
      expect(isValidObservation({ ...validObservation, vaultId: undefined })).toBe(false)
    })

    it('rejects invalid ledger numbers (<= 0, NaN, non-integer)', () => {
      expect(isValidObservation({ ...validObservation, ledgerNumber: 0 })).toBe(false)
      expect(isValidObservation({ ...validObservation, ledgerNumber: -10 })).toBe(false)
      expect(isValidObservation({ ...validObservation, ledgerNumber: NaN })).toBe(false)
      expect(isValidObservation({ ...validObservation, ledgerNumber: 100.5 })).toBe(false)
    })

    it('rejects unknown eventType or status', () => {
      expect(isValidObservation({ ...validObservation, eventType: 'unknown_event' as any })).toBe(false)
      expect(isValidObservation({ ...validObservation, status: 'invalid_status' as any })).toBe(false)
    })

    it('rejects malformed payload (not an object or array)', () => {
      expect(isValidObservation({ ...validObservation, payload: null as any })).toBe(false)
      expect(isValidObservation({ ...validObservation, payload: [] as any })).toBe(false)
      expect(isValidObservation({ ...validObservation, payload: 'string-payload' as any })).toBe(false)
    })
  })

  describe('filterValidObservations', () => {
    it('quarantines invalid observations and returns valid ones with count', () => {
      const observations = [
        validObservation,
        { ...validObservation, eventId: 'evt-2' },
        { ...validObservation, eventId: '', ledgerNumber: -1 }, // invalid
        { ...validObservation, status: 'corrupted' as any }, // invalid
      ]

      const { valid, invalid } = filterValidObservations(observations)
      expect(valid).toHaveLength(2)
      expect(invalid).toBe(2)
    })
  })

  describe('validateScanWindow', () => {
    it('accepts valid scan windows', () => {
      expect(() =>
        validateScanWindow({
          contractAddress: 'CCONTRACT1',
          fromLedger: 100,
          toLedger: 200,
          cursor: '100-0',
        }),
      ).not.toThrow()

      expect(() =>
        validateScanWindow({
          contractAddress: 'CCONTRACT1',
          fromLedger: 100,
          toLedger: null,
          cursor: null,
        }),
      ).not.toThrow()
    })

    it('rejects empty contractAddress', () => {
      expect(() =>
        validateScanWindow({
          contractAddress: '',
          fromLedger: 100,
          toLedger: 200,
          cursor: null,
        }),
      ).toThrow(ReconciliationValidationError)
    })

    it('rejects fromLedger < 1', () => {
      expect(() =>
        validateScanWindow({
          contractAddress: 'CCONTRACT1',
          fromLedger: 0,
          toLedger: 200,
          cursor: null,
        }),
      ).toThrow(ReconciliationValidationError)
    })

    it('rejects toLedger < fromLedger', () => {
      expect(() =>
        validateScanWindow({
          contractAddress: 'CCONTRACT1',
          fromLedger: 200,
          toLedger: 100,
          cursor: null,
        }),
      ).toThrow(ReconciliationValidationError)
    })
  })

  describe('State Machine Monotonicity & Terminal Invariants', () => {
    it('ranks statuses monotonically', () => {
      expect(statusRank('draft')).toBe(0)
      expect(statusRank('active')).toBe(1)
      expect(statusRank('completed')).toBe(2)
      expect(statusRank('failed')).toBe(2)
      expect(statusRank('cancelled')).toBe(2)
      expect(statusRank('nonexistent')).toBe(-1)
    })

    it('allows progression from draft/active to terminal states', () => {
      expect(canApplyObservedStatus('draft', 'active')).toBe(true)
      expect(canApplyObservedStatus('active', 'completed')).toBe(true)
      expect(canApplyObservedStatus('active', 'failed')).toBe(true)
      expect(canApplyObservedStatus('active', 'cancelled')).toBe(true)
    })

    it('strictly forbids terminal state regressions or crossovers', () => {
      // Completed terminal state cannot regress or transition
      expect(canApplyObservedStatus('completed', 'active')).toBe(false)
      expect(canApplyObservedStatus('completed', 'failed')).toBe(false)
      expect(canApplyObservedStatus('completed', 'cancelled')).toBe(false)

      // Failed terminal state cannot regress or transition
      expect(canApplyObservedStatus('failed', 'active')).toBe(false)
      expect(canApplyObservedStatus('failed', 'completed')).toBe(false)
      expect(canApplyObservedStatus('failed', 'cancelled')).toBe(false)

      // Cancelled terminal state cannot regress or transition
      expect(canApplyObservedStatus('cancelled', 'active')).toBe(false)
      expect(canApplyObservedStatus('cancelled', 'completed')).toBe(false)
      expect(canApplyObservedStatus('cancelled', 'failed')).toBe(false)
    })

    it('treats identical status application as idempotent no-op (false)', () => {
      expect(canApplyObservedStatus('active', 'active')).toBe(false)
      expect(canApplyObservedStatus('completed', 'completed')).toBe(false)
    })
  })

  describe('HorizonReconciler Adversarial Execution', () => {
    let mockDb: any
    let trxQueryBuilder: any

    beforeEach(() => {
      trxQueryBuilder = {
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        merge: jest.fn().mockResolvedValue(undefined),
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockResolvedValue(1),
        first: jest.fn().mockResolvedValue({ status: 'active' }),
      }

      const trxFn = jest.fn(() => trxQueryBuilder)
      const mockTrx = Object.assign(trxFn, trxQueryBuilder)

      const dbQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
        insert: jest.fn().mockReturnThis(),
        onConflict: jest.fn().mockReturnThis(),
        merge: jest.fn().mockResolvedValue(undefined),
      }

      const dbFn: any = jest.fn(() => dbQueryBuilder)
      dbFn.transaction = jest.fn(async (callback: any) => callback(mockTrx))
      mockDb = dbFn
    })

    it('rejects empty contractAddress on reconcileContract', async () => {
      const source: HorizonObservationSource = {
        scan: jest.fn<any>(),
      }
      const reconciler = new HorizonReconciler(mockDb, source)

      await expect(reconciler.reconcileContract('')).rejects.toThrow(ReconciliationValidationError)
    })

    it('quarantines adversarial observations from scanned pages without crashing', async () => {
      const source: HorizonObservationSource = {
        scan: jest.fn<any>().mockResolvedValue({
          observations: [
            validObservation,
            { ...validObservation, eventId: '', status: 'invalid' }, // hostile
          ],
          latestLedger: 200,
          nextCursor: '200-0',
        }),
      }

      const reconciler = new HorizonReconciler(mockDb, source, { confirmationDepth: 1 })
      const report = await reconciler.reconcileContract('CCONTRACT1', 1)

      expect(report.observed).toBe(1) // only 1 valid observation
      expect(report.invalid).toBe(1) // 1 invalid observation quarantined
      expect(report.applied).toBe(1)
      expect(report.failed).toBe(0)
    })

    it('does not regress terminal vaults during page persistence', async () => {
      trxQueryBuilder.first.mockResolvedValue({ status: 'completed' }) // Vault is already completed

      const source: HorizonObservationSource = {
        scan: jest.fn<any>().mockResolvedValue({
          observations: [
            {
              ...validObservation,
              status: 'failed',
              eventType: 'vault_failed',
            },
          ],
          latestLedger: 200,
          nextCursor: '200-0',
        }),
      }

      const reconciler = new HorizonReconciler(mockDb, source, { confirmationDepth: 1 })
      const report = await reconciler.reconcileContract('CCONTRACT1', 1)

      expect(report.applied).toBe(0)
      expect(report.alreadyCurrent).toBe(1) // Status transition was safely prevented
      expect(trxQueryBuilder.update).not.toHaveBeenCalled()
    })
  })
})
