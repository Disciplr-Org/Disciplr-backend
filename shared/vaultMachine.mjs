/**
 * Shared vault + milestone lifecycle state machine.
 *
 * Framework-free, pure ESM with zero imports. It is consumed by both the
 * deployed Express API (`api/index.mjs`) and the TypeScript monolith
 * (`src/services/vaultTransitions.ts`), so the rules that run in production are
 * the same ones the monolith exports and the tests exercise.
 *
 * Rules of the module:
 * - No Express, pg database or Node built-in imports. The only host API used is
 *   `globalThis.crypto.randomUUID`, and only as the default activity id source.
 * - Time is injected through `now`; nothing here reads the clock.
 * - Every function returns fresh objects and never mutates its arguments.
 * - Activities are returned, not persisted: callers own storage and ordering.
 *
 * @typedef {'draft' | 'active' | 'completed' | 'failed' | 'cancelled' | 'disputed'} VaultStatus
 * @typedef {'pending' | 'completed' | 'failed' | 'cancelled'} MilestoneStatus
 *
 * @typedef {object} Milestone
 * @property {string} id
 * @property {MilestoneStatus} status
 * @property {string} [title]
 * @property {string | number} [amount]
 *
 * @typedef {object} Vault
 * @property {string} id
 * @property {VaultStatus} status
 * @property {string | number} [amount]
 * @property {Milestone[]} milestones
 *
 * @typedef {object} Activity
 * @property {string} id
 * @property {'validate' | 'release' | 'redirect'} type
 * @property {string} vaultId
 * @property {string | number | undefined} amount
 * @property {'simulated'} status
 * @property {string} hash
 * @property {string} memo
 * @property {string} createdAt
 *
 * @typedef {object} ActivityDeps
 * @property {() => string} [id] Generates activity ids.
 * @property {() => string} [hash] Generates the simulated chain hash.
 *
 * @typedef {'VAULT_NOT_FOUND' | 'VAULT_NOT_ACTIVE' | 'MILESTONE_NOT_FOUND' | 'MILESTONE_ALREADY_COMPLETED' | 'MILESTONE_NOT_PENDING'} MachineErrorCode
 * @typedef {{ ok: true, vault: Vault, activities: Activity[] }} MachineSuccess
 * @typedef {{ ok: false, code: MachineErrorCode, httpStatus: number, message: string }} MachineFailure
 * @typedef {MachineSuccess | MachineFailure} MachineResult
 */

/**
 * Vault-level transition table, aligned with the on-chain `VaultStatus` enum
 * (`contracts/accountability_vault/src/lib.rs`): draft → active | cancelled,
 * active → completed | failed | cancelled | disputed, disputed → active |
 * completed | failed, and terminal states have no exits.
 *
 * @type {Readonly<Record<string, readonly VaultStatus[]>>}
 */
export const VAULT_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['active', 'cancelled']),
  active: Object.freeze(['completed', 'failed', 'cancelled', 'disputed']),
  disputed: Object.freeze(['active', 'completed', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

/** @type {Readonly<ActivityDeps>} */
const DEFAULT_DEPS = Object.freeze({
  id: () => globalThis.crypto.randomUUID(),
  // Two UUIDs minus their dashes: 64 hex characters, matching node:crypto
  // randomBytes(32).toString('hex') used by apilib/store.mjs.
  hash: () => `${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`.replaceAll('-', ''),
})

/** @param {string} code @param {number} httpStatus @param {string} message @returns {MachineFailure} */
const failure = (code, httpStatus, message) => ({ ok: false, code, httpStatus, message })

/** @param {ActivityDeps} [deps] @returns {ActivityDeps} */
const resolveDeps = (deps) => (deps ? { ...DEFAULT_DEPS, ...deps } : DEFAULT_DEPS)

/**
 * Whether `to` is reachable from `from` in one step.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return VAULT_TRANSITIONS[from]?.includes(/** @type {VaultStatus} */ (to)) ?? false
}

/**
 * Validates one milestone of an active vault.
 *
 * Returns the resulting vault (with the milestone marked completed) and the
 * activity rows to persist. The vault completes when every milestone is
 * completed, which appends the release activity one millisecond after the
 * validate activity so release always sorts after it.
 *
 * @param {Vault} vault
 * @param {string} milestoneId
 * @param {Date | string | number} [now]
 * @param {ActivityDeps} [deps]
 * @returns {MachineResult}
 */
export function validateMilestone(vault, milestoneId, now = new Date(), deps) {
  if (!vault) return failure('VAULT_NOT_FOUND', 404, 'Vault not found')
  if (vault.status !== 'active') return failure('VAULT_NOT_ACTIVE', 409, `Vault is ${vault.status}`)

  const index = vault.milestones.findIndex((m) => m.id === milestoneId)
  if (index === -1) return failure('MILESTONE_NOT_FOUND', 404, 'Milestone not found')

  const milestone = vault.milestones[index]
  if (milestone.status === 'completed') {
    return failure('MILESTONE_ALREADY_COMPLETED', 409, 'Milestone already validated')
  }
  // Only failed/cancelled milestones are rejected; any other non-completed status
  // (the API's own rows are pending/completed) stays validatable, matching the
  // deployed handler this module replaced.
  if (milestone.status === 'failed' || milestone.status === 'cancelled') {
    return failure('MILESTONE_NOT_PENDING', 409, `Milestone is ${milestone.status}`)
  }

  const generate = resolveDeps(deps)
  const at = new Date(now).getTime()
  const milestones = vault.milestones.map((m, i) => (
    i === index ? { ...m, status: /** @type {MilestoneStatus} */ ('completed') } : { ...m }
  ))
  const completes = milestones.every((m) => m.status === 'completed')

  /** @type {Activity[]} */
  const activities = [{
    id: generate.id(),
    type: 'validate',
    vaultId: vault.id,
    amount: milestone.amount,
    status: 'simulated',
    hash: generate.hash(),
    memo: `Milestone validated: ${milestone.title}`,
    createdAt: new Date(at).toISOString(),
  }]
  if (completes) {
    activities.push({
      id: generate.id(),
      type: 'release',
      vaultId: vault.id,
      amount: vault.amount,
      status: 'simulated',
      hash: generate.hash(),
      memo: 'Funds released to success destination',
      createdAt: new Date(at + 1).toISOString(),
    })
  }

  return {
    ok: true,
    vault: { ...vault, status: completes ? 'completed' : vault.status, milestones },
    activities,
  }
}

/**
 * Fails an active vault: unmatched milestones become failed, already completed
 * milestones stay completed, and funds redirect to the failure destination.
 *
 * @param {Vault} vault
 * @param {Date | string | number} [now]
 * @param {ActivityDeps} [deps]
 * @returns {MachineResult}
 */
export function failVault(vault, now = new Date(), deps) {
  if (!vault) return failure('VAULT_NOT_FOUND', 404, 'Vault not found')
  if (vault.status !== 'active') return failure('VAULT_NOT_ACTIVE', 409, `Vault is ${vault.status}`)

  const generate = resolveDeps(deps)
  return {
    ok: true,
    vault: {
      ...vault,
      status: 'failed',
      milestones: vault.milestones.map((m) => ({
        ...m,
        status: m.status === 'completed' ? 'completed' : /** @type {MilestoneStatus} */ ('failed'),
      })),
    },
    activities: [{
      id: generate.id(),
      type: 'redirect',
      vaultId: vault.id,
      amount: vault.amount,
      status: 'simulated',
      hash: generate.hash(),
      memo: 'Funds redirected to failure destination',
      createdAt: new Date(now).toISOString(),
    }],
  }
}
