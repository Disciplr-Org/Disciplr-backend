// Property-based invariants for shared/vaultMachine.mjs (fast-check).
//
// These run randomized vaults through randomized validate/fail sequences and
// assert the invariants the deployed API and the monolith rely on. Inputs are
// deep-frozen before every operation, so any mutation throws instead of being
// silently tolerated.
import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { VAULT_TRANSITIONS, canTransition, failVault, validateMilestone } from '../vaultMachine.mjs'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const MILESTONE_STATUSES = ['pending', 'completed', 'failed', 'cancelled']
const VAULT_STATUSES = ['draft', 'active', 'completed', 'failed', 'cancelled', 'disputed']

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const deterministicDeps = () => {
  let n = 0
  return { id: () => `activity-${++n}`, hash: () => `hash-${n}` }
}

const vaultArb = fc
  .record({
    status: fc.constantFrom(...VAULT_STATUSES),
    count: fc.integer({ min: 1, max: 4 }),
    statuses: fc.array(fc.constantFrom(...MILESTONE_STATUSES), { minLength: 4, maxLength: 4 }),
  })
  .map(({ status, count, statuses }) => ({
    id: 'vault-1',
    status,
    amount: '1000',
    milestones: statuses.slice(0, count).map((milestoneStatus, index) => ({
      id: `m${index + 1}`,
      title: `Task ${index + 1}`,
      amount: String((index + 1) * 100),
      status: milestoneStatus,
    })),
  }))

const operationArb = fc.oneof(
  fc.constantFrom('m1', 'm2', 'm3', 'm4', 'missing').map((milestoneId) => ({ type: 'validate', milestoneId })),
  fc.constant({ type: 'fail' }),
)

const operationsArb = fc.array(operationArb, { minLength: 1, maxLength: 10 })

/**
 * Runs operations against a copy-on-write vault, asserting after each step that
 * the (deep-frozen) input was not mutated. Returns the observed steps.
 */
function execute(vault, operations) {
  let current = vault
  const steps = []
  const generate = deterministicDeps()
  let tick = 0

  for (const operation of operations) {
    const now = new Date(NOW.getTime() + (tick += 1000))
    const input = deepFreeze(structuredClone(current))
    const before = structuredClone(input)
    const result = operation.type === 'validate'
      ? validateMilestone(input, operation.milestoneId, now, generate)
      : failVault(input, now, generate)

    assert.deepEqual(input, before, 'machine mutated its input')
    assert.equal(input.status, before.status)
    steps.push({ operation, before, now, result })
    if (result.ok) current = result.vault
  }

  return steps
}

test('terminal vault statuses are absorbing', () => {
  fc.assert(
    fc.property(vaultArb, operationsArb, (vault, operations) => {
      fc.pre(TERMINAL_STATUSES.has(vault.status))
      for (const operation of operations) {
        const result = operation.type === 'validate'
          ? validateMilestone(vault, operation.milestoneId, NOW)
          : failVault(vault, NOW)
        assert.equal(result.ok, false)
        assert.equal(result.code, 'VAULT_NOT_ACTIVE')
        assert.equal(result.httpStatus, 409)
        assert.equal(result.message, `Vault is ${vault.status}`)
      }
    }),
    { numRuns: 100 },
  )
})

test('a vault is completed iff every milestone is completed after a validate', () => {
  fc.assert(
    fc.property(vaultArb, operationsArb, (vault, operations) => {
      for (const step of execute(vault, operations)) {
        if (step.operation.type !== 'validate' || !step.result.ok) continue
        const allCompleted = step.result.vault.milestones.every((m) => m.status === 'completed')
        assert.equal(step.result.vault.status === 'completed', allCompleted)
      }
    }),
    { numRuns: 150 },
  )
})

test('failVault never changes a completed milestone', () => {
  fc.assert(
    fc.property(vaultArb, operationsArb, (vault, operations) => {
      for (const step of execute(vault, operations)) {
        if (step.operation.type !== 'fail' || !step.result.ok) continue
        assert.equal(step.result.vault.status, 'failed')
        step.before.milestones.forEach((milestone, index) => {
          if (milestone.status === 'completed') {
            assert.equal(step.result.vault.milestones[index].status, 'completed')
          } else {
            assert.equal(step.result.vault.milestones[index].status, 'failed')
          }
        })
      }
    }),
    { numRuns: 150 },
  )
})

test('release and redirect activities appear at most once over any sequence', () => {
  fc.assert(
    fc.property(vaultArb, operationsArb, (vault, operations) => {
      const activities = execute(vault, operations)
        .flatMap((step) => (step.result.ok ? step.result.activities : []))
      const payouts = activities.filter((a) => a.type === 'release' || a.type === 'redirect')
      assert.ok(payouts.length <= 1, `expected at most one payout, got ${payouts.length}`)
    }),
    { numRuns: 150 },
  )
})

test('status changes are always allowed transitions', () => {
  fc.assert(
    fc.property(vaultArb, operationsArb, (vault, operations) => {
      for (const step of execute(vault, operations)) {
        if (!step.result.ok) continue
        if (step.result.vault.status === step.before.status) {
          // Only a non-final milestone validation keeps the vault active.
          assert.equal(step.result.vault.status, 'active')
          continue
        }
        const allowed = VAULT_TRANSITIONS[step.before.status] ?? []
        assert.ok(allowed.includes(step.result.vault.status))
        assert.ok(canTransition(step.before.status, step.result.vault.status))
      }
    }),
    { numRuns: 150 },
  )
})

test('activities are timestamped from the injected clock, release after validate', () => {
  fc.assert(
    fc.property(vaultArb, operationsArb, (vault, operations) => {
      for (const step of execute(vault, operations)) {
        if (!step.result.ok) continue
        const [first, second] = step.result.activities
        assert.equal(first.createdAt, step.now.toISOString())
        if (second) {
          assert.equal(first.type, 'validate')
          assert.equal(second.type, 'release')
          assert.equal(second.createdAt, new Date(step.now.getTime() + 1).toISOString())
          assert.ok(second.createdAt > first.createdAt)
        }
      }
    }),
    { numRuns: 150 },
  )
})
