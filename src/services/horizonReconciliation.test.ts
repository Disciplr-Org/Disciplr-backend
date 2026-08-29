import {
  calculateStartLedger,
  canApplyObservedStatus,
  deduplicateObservations,
  isConfirmed,
  latestObservationByVault,
  reconcileWithRetry,
  retryDelay,
  statusRank,
  type HorizonObservation,
} from './horizonReconciliation.js'

const observation = (overrides: Partial<HorizonObservation> = {}): HorizonObservation => ({
  eventId: 'event-1',
  contractAddress: 'CA-test',
  vaultId: 'vault-1',
  transactionHash: 'tx-1',
  ledgerNumber: 100,
  pagingToken: '100-0',
  eventType: 'vault_completed',
  status: 'completed',
  payload: {},
  ...overrides,
})

describe('Horizon reconciliation policy', () => {
  test('ranks active below terminal states', () => {
    expect(statusRank('draft')).toBe(0)
    expect(statusRank('active')).toBe(1)
    expect(statusRank('completed')).toBe(2)
    expect(statusRank('unknown')).toBe(-1)
  })

  test('does not regress terminal vaults', () => {
    expect(canApplyObservedStatus('completed', 'failed')).toBe(false)
    expect(canApplyObservedStatus('failed', 'cancelled')).toBe(false)
    expect(canApplyObservedStatus('active', 'completed')).toBe(true)
    expect(canApplyObservedStatus('draft', 'active')).toBe(true)
    expect(canApplyObservedStatus('active', 'active')).toBe(false)
    expect(canApplyObservedStatus(null, 'active')).toBe(true)
  })

  test('requires a non-negative confirmation depth', () => {
    expect(isConfirmed(100, 102, 2)).toBe(true)
    expect(isConfirmed(100, 101, 2)).toBe(false)
    expect(isConfirmed(100, 99, 0)).toBe(false)
    expect(isConfirmed(100, 100, 0)).toBe(true)
    expect(isConfirmed(100, 100, -1)).toBe(false)
  })

  test('deduplicates replayed event IDs and keeps the first record', () => {
    const first = observation()
    const duplicate = observation({ transactionHash: 'different', ledgerNumber: 101 })
    const result = deduplicateObservations([first, duplicate, observation({ eventId: 'event-2' })])
    expect(result.duplicates).toBe(1)
    expect(result.unique).toEqual([first, observation({ eventId: 'event-2' })])
  })

  test('selects the latest event per vault deterministically', () => {
    const latest = observation({ eventId: 'event-2', ledgerNumber: 101, status: 'failed', eventType: 'vault_failed' })
    const tieBreaker = observation({ eventId: 'event-3', ledgerNumber: 101, status: 'cancelled', eventType: 'vault_cancelled' })
    const result = latestObservationByVault([observation(), tieBreaker, latest])
    expect(result.get('vault-1')?.eventId).toBe('event-3')
  })

  test('restarts with a bounded overlap around the confirmed cursor', () => {
    expect(calculateStartLedger(null, 55, 32)).toBe(55)
    expect(calculateStartLedger({ confirmedLedger: 100, scanLedger: 140 }, 1, 32)).toBe(69)
    expect(calculateStartLedger({ confirmedLedger: 3, scanLedger: 140 }, 1, 32)).toBe(1)
    expect(calculateStartLedger({ confirmedLedger: 100, scanLedger: 0 }, 1, 0)).toBe(100)
  })

  test('retry delay is bounded and deterministic', () => {
    expect(retryDelay(0, 100, 1_000)).toBe(0)
    expect(retryDelay(1, 100, 1_000)).toBe(100)
    expect(retryDelay(2, 100, 1_000)).toBe(200)
    expect(retryDelay(5, 100, 1_000)).toBe(1_000)
    expect(retryDelay(1, -1, 0)).toBe(0)
  })

  test('retry helper returns the first successful report', async () => {
    let calls = 0
    const waits: number[] = []
    const report = { contractAddress: 'CA-test', applied: 1 } as any
    const result = await reconcileWithRetry(
      {
        async reconcileContract() {
          calls++
          if (calls < 3) throw new Error('temporary Horizon failure')
          return report
        },
      },
      'CA-test',
      1,
      { maxAttempts: 3, initialBackoffMs: 10, maxBackoffMs: 20 },
      async delay => {
        waits.push(delay)
      },
    )
    expect(result).toBe(report)
    expect(calls).toBe(3)
    expect(waits).toEqual([10, 20])
  })

  test('retry helper surfaces the final failure', async () => {
    const wait = jest.fn(async () => undefined)
    await expect(
      reconcileWithRetry(
        { async reconcileContract() { throw new Error('unavailable') } },
        'CA-test',
        1,
        { maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1 },
        wait,
      ),
    ).rejects.toThrow('unavailable')
    expect(wait).toHaveBeenCalledTimes(1)
  })

  test('confirmation is based on ledger distance rather than event order', () => {
    const events = [
      observation({ eventId: 'old', ledgerNumber: 10 }),
      observation({ eventId: 'new', ledgerNumber: 20 }),
    ]
    const confirmed = events.filter(event => isConfirmed(event.ledgerNumber, 12, 2))
    expect(confirmed.map(event => event.eventId)).toEqual(['old'])
  })
})
