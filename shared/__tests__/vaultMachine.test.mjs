// Unit coverage for shared/vaultMachine.mjs: one test per error code plus the
// success shapes, activity rows and immutability guarantees.
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { VAULT_TRANSITIONS, canTransition, failVault, validateMilestone } from '../vaultMachine.mjs'

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const NOW = new Date('2026-01-02T03:04:05.000Z')

const counterDeps = () => {
  let n = 0
  return { id: () => `activity-${++n}`, hash: () => `hash-${n}` }
}

function makeMilestone(overrides = {}) {
  return { id: 'm1', title: 'Ship it', amount: '100', status: 'pending', ...overrides }
}

function makeVault(overrides = {}) {
  return {
    id: 'vault-1',
    status: 'active',
    amount: '300',
    milestones: [makeMilestone()],
    ...overrides,
  }
}

function snapshotVault(vault) {
  return structuredClone(vault)
}

describe('VAULT_TRANSITIONS', () => {
  test('matches the contract lifecycle table', () => {
    assert.deepEqual(VAULT_TRANSITIONS, {
      draft: ['active', 'cancelled'],
      active: ['completed', 'failed', 'cancelled', 'disputed'],
      disputed: ['active', 'completed', 'failed'],
      completed: [],
      failed: [],
      cancelled: [],
    })
  })

  test('is frozen, including terminal empty lists', () => {
    assert.ok(Object.isFrozen(VAULT_TRANSITIONS))
    for (const targets of Object.values(VAULT_TRANSITIONS)) assert.ok(Object.isFrozen(targets))
  })

  test('canTransition agrees with the table and rejects unknown states', () => {
    assert.equal(canTransition('draft', 'active'), true)
    assert.equal(canTransition('draft', 'completed'), false)
    assert.equal(canTransition('active', 'disputed'), true)
    assert.equal(canTransition('disputed', 'cancelled'), false)
    assert.equal(canTransition('completed', 'active'), false)
    assert.equal(canTransition('nonsense', 'active'), false)
  })
})

describe('validateMilestone error codes', () => {
  test('VAULT_NOT_FOUND (404) for a missing vault', () => {
    const result = validateMilestone(null, 'm1', NOW)
    assert.deepEqual(result, {
      ok: false,
      code: 'VAULT_NOT_FOUND',
      httpStatus: 404,
      message: 'Vault not found',
    })
  })

  for (const status of ['draft', 'completed', 'failed', 'cancelled', 'disputed']) {
    test(`VAULT_NOT_ACTIVE (409) for a ${status} vault`, () => {
      const vault = makeVault({ status })
      const result = validateMilestone(vault, 'm1', NOW)
      assert.deepEqual(result, {
        ok: false,
        code: 'VAULT_NOT_ACTIVE',
        httpStatus: 409,
        message: `Vault is ${status}`,
      })
    })
  }

  test('MILESTONE_NOT_FOUND (404)', () => {
    const result = validateMilestone(makeVault(), 'missing', NOW)
    assert.deepEqual(result, {
      ok: false,
      code: 'MILESTONE_NOT_FOUND',
      httpStatus: 404,
      message: 'Milestone not found',
    })
  })

  test('MILESTONE_ALREADY_COMPLETED (409)', () => {
    const vault = makeVault({ milestones: [makeMilestone({ status: 'completed' })] })
    const result = validateMilestone(vault, 'm1', NOW)
    assert.deepEqual(result, {
      ok: false,
      code: 'MILESTONE_ALREADY_COMPLETED',
      httpStatus: 409,
      message: 'Milestone already validated',
    })
  })

  for (const status of ['failed', 'cancelled']) {
    test(`MILESTONE_NOT_PENDING (409) for a ${status} milestone`, () => {
      const vault = makeVault({ milestones: [makeMilestone({ status })] })
      const result = validateMilestone(vault, 'm1', NOW)
      assert.deepEqual(result, {
        ok: false,
        code: 'MILESTONE_NOT_PENDING',
        httpStatus: 409,
        message: `Milestone is ${status}`,
      })
    })
  }

  test('keeps non-completed workflow statuses validatable', () => {
    // The deployed API only writes pending/completed/failed, but rows created by
    // other services can be in_progress/approved; those still validate.
    const vault = makeVault({ milestones: [makeMilestone({ status: 'in_progress' })] })
    const result = validateMilestone(vault, 'm1', NOW, counterDeps())
    assert.equal(result.ok, true)
    assert.equal(result.vault.milestones[0].status, 'completed')
  })

  test('every failure leaves the vault untouched and emits no activities', () => {
    const vault = deepFreeze(makeVault({ milestones: [makeMilestone(), makeMilestone({ id: 'm2' })] }))
    const before = snapshotVault(vault)
    for (const result of [
      validateMilestone(vault, 'missing', NOW),
      validateMilestone(makeVault({ status: 'draft' }), 'm1', NOW),
      failVault(makeVault({ status: 'draft' }), NOW),
    ]) {
      assert.equal(result.ok, false)
      assert.equal(Object.hasOwn(result, 'vault'), false)
      assert.equal(Object.hasOwn(result, 'activities'), false)
    }
    assert.deepEqual(vault, before)
  })
})

describe('validateMilestone success', () => {
  test('completes the milestone without changing an active vault', () => {
    const vault = deepFreeze(makeVault({ milestones: [makeMilestone(), makeMilestone({ id: 'm2', amount: '200' })] }))
    const before = snapshotVault(vault)

    const result = validateMilestone(vault, 'm1', NOW, counterDeps())

    assert.equal(result.ok, true)
    assert.equal(result.vault.status, 'active')
    assert.deepEqual(result.vault.milestones.map((m) => m.status), ['completed', 'pending'])
    assert.deepEqual(result.activities, [{
      id: 'activity-1',
      type: 'validate',
      vaultId: 'vault-1',
      amount: '100',
      status: 'simulated',
      hash: 'hash-1',
      memo: 'Milestone validated: Ship it',
      createdAt: NOW.toISOString(),
    }])
    // Inputs are frozen and unchanged; results are fresh objects.
    assert.deepEqual(vault, before)
    assert.notEqual(result.vault, vault)
    assert.notEqual(result.vault.milestones[0], vault.milestones[0])
  })

  test('completes the vault and releases funds after the final milestone', () => {
    const vault = deepFreeze(makeVault({
      milestones: [makeMilestone({ status: 'completed' }), makeMilestone({ id: 'm2', amount: '200' })],
    }))
    const result = validateMilestone(vault, 'm2', NOW, counterDeps())

    assert.equal(result.ok, true)
    assert.equal(result.vault.status, 'completed')
    assert.deepEqual(result.activities.map((a) => a.type), ['validate', 'release'])
    assert.equal(result.activities[1].amount, '300')
    assert.equal(result.activities[1].memo, 'Funds released to success destination')
    // Release is stamped 1 ms after the validate row so ordering is explicit.
    assert.equal(result.activities[0].createdAt, NOW.toISOString())
    assert.equal(result.activities[1].createdAt, new Date(NOW.getTime() + 1).toISOString())
    assert.ok(result.activities[1].createdAt > result.activities[0].createdAt)
  })

  test('accepts an ISO string as `now` and never reads the clock', () => {
    const iso = '2030-05-06T07:08:09.010Z'
    const result = validateMilestone(makeVault(), 'm1', iso, counterDeps())
    assert.equal(result.activities[0].createdAt, iso)
  })
})

describe('failVault', () => {
  test('fails pending milestones, preserves completed ones and redirects funds', () => {
    const vault = deepFreeze(makeVault({
      milestones: [
        makeMilestone({ status: 'completed' }),
        makeMilestone({ id: 'm2', status: 'pending' }),
        makeMilestone({ id: 'm3', status: 'cancelled' }),
      ],
    }))
    const before = snapshotVault(vault)

    const result = failVault(vault, NOW, counterDeps())

    assert.equal(result.ok, true)
    assert.equal(result.vault.status, 'failed')
    assert.deepEqual(result.vault.milestones.map((m) => m.status), ['completed', 'failed', 'failed'])
    assert.deepEqual(result.activities, [{
      id: 'activity-1',
      type: 'redirect',
      vaultId: 'vault-1',
      amount: '300',
      status: 'simulated',
      hash: 'hash-1',
      memo: 'Funds redirected to failure destination',
      createdAt: NOW.toISOString(),
    }])
    assert.deepEqual(vault, before)
  })

  test('VAULT_NOT_FOUND (404) for a missing vault', () => {
    const result = failVault(undefined, NOW)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'VAULT_NOT_FOUND')
    assert.equal(result.httpStatus, 404)
    assert.equal(result.message, 'Vault not found')
  })

  for (const status of ['draft', 'completed', 'failed', 'cancelled', 'disputed']) {
    test(`VAULT_NOT_ACTIVE (409) for a ${status} vault`, () => {
      const result = failVault(makeVault({ status }), NOW)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'VAULT_NOT_ACTIVE')
      assert.equal(result.httpStatus, 409)
      assert.equal(result.message, `Vault is ${status}`)
    })
  }

  test('never changes a completed milestone on an active vault', () => {
    const vault = makeVault({
      milestones: [
        makeMilestone({ status: 'completed' }),
        makeMilestone({ id: 'm2', status: 'failed' }),
      ],
    })
    const result = failVault(vault, NOW, counterDeps())
    assert.equal(result.ok, true)
    assert.equal(result.vault.milestones[0].status, 'completed')
    assert.equal(result.vault.milestones[1].status, 'failed')
  })
})
