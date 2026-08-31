import {
  assertSettlementConfirmed,
  SettlementOperationError,
  SettlementOperationLedger,
} from './settlementOperations.js'
import { describe, expect, it } from '@jest/globals'

const request = (overrides: Record<string, unknown> = {}) => ({
  milestoneId: 'ms-1499-test',
  operationKey: 'release-2026-08-30',
  operationType: 'release' as const,
  requestedBy: 'creator-1',
  destination: 'GDESTINATION',
  amount: '100.0000000',
  assetCode: 'USDC',
  ...overrides,
})

const tx = 'tx-hash-0001'

describe('settlement operation identity', () => {
  it('creates a pending operation with no side effect status', () => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())

    expect(operation.id).toBeTruthy()
    expect(operation.status).toBe('pending')
    expect(operation.attemptCount).toBe(0)
    expect(operation.operationType).toBe('release')
    expect(operation.transactionHash).toBeNull()
    expect(operation.submittedAt).toBeNull()
    expect(operation.confirmedAt).toBeNull()
  })

  it('returns the same operation for an identical retry', () => {
    const ledger = new SettlementOperationLedger()
    const first = ledger.create(request())
    const retry = ledger.create(request())

    expect(retry).toEqual(first)
    expect(ledger.snapshot()).toHaveLength(1)
  })

  it.each([
    ['operationType', { operationType: 'unknown' }],
    ['operationKey', { operationKey: 'contains spaces' }],
    ['amount', { amount: '0' }],
    ['destination', { destination: '' }],
    ['requestedBy', { requestedBy: '' }],
  ])('rejects malformed %s before allocation', (_field, overrides) => {
    const ledger = new SettlementOperationLedger()
    expect(() => ledger.create(request(overrides))).toThrow(SettlementOperationError)
    expect(ledger.snapshot()).toEqual([])
  })

  it('rejects an idempotency-key reuse with a changed destination', () => {
    const ledger = new SettlementOperationLedger()
    ledger.create(request())

    expect(() => ledger.create(request({ destination: 'GOTHERDESTINATION' }))).toThrow(/different settlement request/i)
    expect(ledger.snapshot()).toHaveLength(1)
  })

  it('allows release and redirect to share no identity', () => {
    const ledger = new SettlementOperationLedger()
    const release = ledger.create(request())
    const redirect = ledger.create(request({ operationType: 'redirect', operationKey: 'redirect-2026-08-30' }))

    expect(redirect.id).not.toBe(release.id)
    expect(ledger.snapshot()).toHaveLength(2)
  })
})

describe('submission and retry state machine', () => {
  it('moves pending to submitted exactly once', () => {
    const ledger = new SettlementOperationLedger()
    const pending = ledger.create(request())
    const submitted = ledger.submit(pending.id, tx)
    const retry = ledger.submit(pending.id, tx)

    expect(submitted.status).toBe('submitted')
    expect(submitted.attemptCount).toBe(1)
    expect(retry).toEqual(submitted)
    expect(ledger.snapshot()[0]?.attemptCount).toBe(1)
  })

  it('rejects a second transaction hash for a submitted operation', () => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())
    ledger.submit(operation.id, tx)

    expect(() => ledger.submit(operation.id, 'tx-hash-0002')).toThrow(/another transaction/i)
    expect(ledger.get(operation.id)?.attemptCount).toBe(1)
  })

  it.each(['short', '', 'contains spaces'])('rejects malformed transaction hashes (%s)', (hash) => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())
    expect(() => ledger.submit(operation.id, hash)).toThrow(/transactionHash/i)
    expect(ledger.get(operation.id)?.status).toBe('pending')
  })

  it('records a failure as recoverable and increments attempts on retry', () => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())
    ledger.submit(operation.id, tx)
    const failed = ledger.fail(operation.id, 'RPC_TIMEOUT', 'Soroban RPC timed out')
    const retry = ledger.submit(operation.id, 'tx-hash-0002')

    expect(failed.status).toBe('failed')
    expect(failed.failureCode).toBe('RPC_TIMEOUT')
    expect(failed.failureMessage).toBe('Soroban RPC timed out')
    expect(retry.status).toBe('submitted')
    expect(retry.attemptCount).toBe(2)
    expect(retry.failureCode).toBeNull()
  })

  it('does not allow failed or pending operations to be confirmed', () => {
    const ledger = new SettlementOperationLedger()
    const pending = ledger.create(request())
    expect(() => ledger.confirm(pending.id, tx)).toThrow(/submitted/i)
    ledger.submit(pending.id, tx)
    ledger.fail(pending.id, 'REJECTED_TX', 'Transaction rejected')
    expect(() => ledger.confirm(pending.id, tx)).toThrow(/submitted/i)
  })
})

describe('confirmation gate', () => {
  it('exposes a completion guard that rejects every non-confirmed state', () => {
    for (const status of ['pending', 'submitted', 'failed'] as const) {
      expect(() => assertSettlementConfirmed({ status })).toThrow(/not confirmed/i)
    }
    expect(() => assertSettlementConfirmed({ status: 'confirmed' })).not.toThrow()
  })

  it('confirms only the exact submitted transaction', () => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())
    ledger.submit(operation.id, tx)

    expect(() => ledger.confirm(operation.id, 'tx-hash-0002')).toThrow(/does not match/i)
    expect(ledger.get(operation.id)?.status).toBe('submitted')

    const confirmed = ledger.confirm(operation.id, tx)
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.confirmedAt).toBeTruthy()
  })

  it('makes the confirmation callback idempotent', () => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())
    ledger.submit(operation.id, tx)
    const first = ledger.confirm(operation.id, tx)
    const replay = ledger.confirm(operation.id, tx)

    expect(replay).toEqual(first)
    expect(ledger.snapshot()).toHaveLength(1)
  })

  it('rejects a different callback after confirmation', () => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())
    ledger.submit(operation.id, tx)
    ledger.confirm(operation.id, tx)

    expect(() => ledger.confirm(operation.id, 'tx-hash-0002')).toThrow(/another transaction/i)
  })

  it('does not permit a confirmed operation to be resubmitted', () => {
    const ledger = new SettlementOperationLedger()
    const operation = ledger.create(request())
    ledger.submit(operation.id, tx)
    ledger.confirm(operation.id, tx)

    const result = ledger.submit(operation.id, 'tx-hash-0002')
    expect(result.status).toBe('confirmed')
    expect(result.transactionHash).toBe(tx)
    expect(result.attemptCount).toBe(1)
  })
})

describe('restart recovery', () => {
  it('restores pending, submitted, failed, and confirmed operations', () => {
    const firstProcess = new SettlementOperationLedger()
    const pending = firstProcess.create(request({ operationKey: 'pending' }))
    const submitted = firstProcess.create(request({ operationKey: 'submitted' }))
    firstProcess.submit(submitted.id, 'tx-hash-0003')
    const failed = firstProcess.create(request({ operationKey: 'failed' }))
    firstProcess.submit(failed.id, 'tx-hash-0004')
    firstProcess.fail(failed.id, 'NETWORK_ERROR', 'Network unavailable')
    const confirmed = firstProcess.create(request({ operationKey: 'confirmed' }))
    firstProcess.submit(confirmed.id, 'tx-hash-0005')
    firstProcess.confirm(confirmed.id, 'tx-hash-0005')

    const secondProcess = new SettlementOperationLedger()
    secondProcess.restore(firstProcess.snapshot())

    expect(secondProcess.get(pending.id)?.status).toBe('pending')
    expect(secondProcess.get(submitted.id)?.status).toBe('submitted')
    expect(secondProcess.get(failed.id)?.status).toBe('failed')
    expect(secondProcess.get(confirmed.id)?.status).toBe('confirmed')
    expect(secondProcess.create(request({ operationKey: 'pending' })).id).toBe(pending.id)
  })

  it('retries the same failed logical operation after restoration', () => {
    const firstProcess = new SettlementOperationLedger()
    const operation = firstProcess.create(request())
    firstProcess.submit(operation.id, tx)
    firstProcess.fail(operation.id, 'TIMEOUT', 'Submission timed out')

    const secondProcess = new SettlementOperationLedger()
    secondProcess.restore(firstProcess.snapshot())
    const retry = secondProcess.submit(operation.id, 'tx-hash-0006')

    expect(retry.id).toBe(operation.id)
    expect(retry.attemptCount).toBe(2)
    expect(retry.status).toBe('submitted')
  })

  it('does not silently replace restored records with a new operation', () => {
    const source = new SettlementOperationLedger()
    const original = source.create(request())
    const restored = new SettlementOperationLedger()
    restored.restore(source.snapshot())

    const replay = restored.create(request())
    expect(replay.id).toBe(original.id)
    expect(restored.snapshot()).toHaveLength(1)
  })
})
