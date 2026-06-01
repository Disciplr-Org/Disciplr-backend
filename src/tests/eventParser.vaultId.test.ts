import { parseHorizonEvent } from '../services/eventParser.js'

describe('eventParser vaultId format validation', () => {
  const txHash = 'abcdef1234567890'

  test('accepts valid UUID vaultId in vault_created', () => {
    const payload = {
      vaultId: '550e8400-e29b-41d4-a716-446655440000',
      creator: 'GCREATORADDRESS',
      amount: '1000.0000000',
      startTimestamp: new Date().toISOString(),
      endTimestamp: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      successDestination: 'GSUCCESSDEST',
      failureDestination: 'GFAILUREDEST'
    }

    const rawEvent = {
      type: 'contract_event',
      ledger: 123,
      ledgerClosedAt: new Date().toISOString(),
      contractId: 'C1',
      id: `${txHash}-0`,
      pagingToken: 'pt',
      topic: ['vault_created'],
      value: { xdr: JSON.stringify(payload) },
      inSuccessfulContractCall: true,
      txHash
    }

    const result = parseHorizonEvent(rawEvent as any)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.event.payload.vaultId).toBe(payload.vaultId)
    }
  })

  test('rejects invalid vaultId format in vault_created', () => {
    const payload = {
      vaultId: 'not-a-uuid',
      creator: 'GCREATORADDRESS',
      amount: '1000.0000000',
      startTimestamp: new Date().toISOString(),
      endTimestamp: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      successDestination: 'GSUCCESSDEST',
      failureDestination: 'GFAILUREDEST'
    }

    const rawEvent = {
      type: 'contract_event',
      ledger: 124,
      ledgerClosedAt: new Date().toISOString(),
      contractId: 'C1',
      id: `${txHash}-0`,
      pagingToken: 'pt',
      topic: ['vault_created'],
      value: { xdr: JSON.stringify(payload) },
      inSuccessfulContractCall: true,
      txHash
    }

    const result = parseHorizonEvent(rawEvent as any)
    expect(result.success).toBe(false)
  })
})
