import client from 'prom-client'
import { register } from './metricsRegistry.js'

const methods = ['create_vault', 'stake', 'check_in', 'slash_on_miss', 'claim', 'withdraw'] as const
type SorobanMethod = (typeof methods)[number]
type Outcome = 'success' | 'failure'

const transactionsTotal = new client.Counter({
  name: 'disciplr_soroban_transactions_total',
  help: 'Soroban transaction attempts by bounded method and outcome.',
  labelNames: ['method', 'outcome'],
  registers: [register],
})

const transactionDuration = new client.Histogram({
  name: 'disciplr_soroban_transaction_duration_seconds',
  help: 'Soroban transaction duration by bounded method and outcome.',
  labelNames: ['method', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
})

/** Normalize method names before they become metric labels. */
function metricMethod(method: string): SorobanMethod | 'other' {
  return (methods as readonly string[]).includes(method) ? method as SorobanMethod : 'other'
}

export function recordSorobanTransaction(method: string, outcome: Outcome, durationMs: number): void {
  const labels = { method: metricMethod(method), outcome }
  transactionsTotal.inc(labels)
  transactionDuration.observe(labels, Math.max(0, durationMs) / 1000)
}
