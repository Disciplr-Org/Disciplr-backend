import { beforeEach, describe, expect, it } from '@jest/globals'
import { register } from '../observability/metricsRegistry.js'
import { recordSorobanTransaction } from '../observability/sorobanMetrics.js'

describe('Soroban operational metrics', () => {
  beforeEach(async () => {
    register.resetMetrics()
  })

  it('records bounded method and outcome labels', async () => {
    recordSorobanTransaction('stake', 'success', 125)
    recordSorobanTransaction('unexpected-contract-method-with-user-input', 'failure', 25)

    const output = await register.metrics()
    expect(output).toContain('disciplr_soroban_transactions_total{method="stake",outcome="success"} 1')
    expect(output).toContain('disciplr_soroban_transactions_total{method="other",outcome="failure"} 1')
    expect(output).toContain('disciplr_soroban_transaction_duration_seconds')
    expect(output).not.toContain('unexpected-contract-method-with-user-input')
  })
})
