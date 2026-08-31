import { allMilestonesVerified } from './milestones.js'
import { type Knex } from 'knex';
import { UserRole } from '../types/user.js';
import { getEnv } from '../config/index.js'
import { toUTCDate } from '../utils/timestamps.js'

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

// In-memory vault array for test compatibility (used by legacy transition functions)
let memoryVaults: any[] = [];
export const setTestVaults = (newVaults: any[]) => { memoryVaults = newVaults };

export interface Vault {
  id: string
  creator: string
  amount: string
  status: 'draft' | 'active' | 'completed' | 'failed' | 'cancelled' | 'disputed'
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  verifier?: string
  createdAt: string
  endDate?: string  // Alias for endTimestamp (used in some tests)
  lateCheckInWindowSecs?: number
}

export interface TransitionResult {
  success: boolean;
  error?: string;
}

export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['active', 'cancelled'],
  active: ['completed', 'failed', 'cancelled', 'disputed'],
  disputed: ['active', 'completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

// Utility function for exhaustive type checking
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}


const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

const findVault = (vaultId: string): Vault | undefined =>
  memoryVaults.find((v) => v.id === vaultId);

export const resetTestVaults = (): void => {
  memoryVaults = [];
};

export const isValidTransition = (
  currentStatus: string,
  targetStatus: TerminalStatus
): boolean => {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  return allowed?.includes(targetStatus) || false;
};

export const getTransitionError = (
  vault: Vault,
  targetStatus: TerminalStatus,
  requesterId?: string,
): string | null => {
  if (TERMINAL_STATUSES.has(vault.status)) {
    return `Vault is already '${vault.status}' and cannot transition`;
  }

  if (!isValidTransition(vault.status, targetStatus)) {
    const allowed = ALLOWED_TRANSITIONS[vault.status];
    return `Invalid transition: '${vault.status}' -> '${targetStatus}'. Allowed: ${allowed?.join(', ') || 'none'}`;
  }

  switch (targetStatus) {
    case 'completed':
      if (!allMilestonesVerified(vault.id)) {
        return 'Cannot complete vault: not all milestones are verified';
      }
      return null;
    case 'failed': {
      const now = Date.now();
      const endMs = toUTCDate(vault.endTimestamp).getTime();
      let skewMs = 10_000; // fallback if env is not yet initialized
      try {
        skewMs = getEnv().VAULT_TRANSITION_SKEW_MS;
      } catch {
        // env not initialized in tests; use the fallback default
      }
      // Allow the transition when endTimestamp has already passed OR is within
      // the clock-skew window (end - now <= skewMs).  This prevents a vault
      // whose deadline was reached on a slightly-ahead scheduler from being
      // incorrectly rejected by a server whose clock is a few seconds behind.
      if (endMs - now > skewMs) {
        return 'Cannot fail vault: endTimestamp has not passed yet';
      }
      return null;
    }
    case 'cancelled':
      if (!requesterId || requesterId !== vault.creator) {
        return 'Cannot cancel vault: only the creator can cancel';
      }
      return null;
    default:
      // Ensure exhaustive handling of TerminalStatus
      return assertNever(targetStatus as never);
    };
};

export const completeVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId);
  if (!vault) return { success: false, error: 'Vault not found' };
  const error = getTransitionError(vault, 'completed');
  if (error) return { success: false, error };
  vault.status = 'completed';
  return { success: true };
};

export const failVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId);
  if (!vault) return { success: false, error: 'Vault not found' };
  const error = getTransitionError(vault, 'failed');
  if (error) return { success: false, error };
  vault.status = 'failed';
  return { success: true };
};

export const cancelVault = (vaultId: string, requesterId: string): TransitionResult => {
  const vault = findVault(vaultId);
  if (!vault) return { success: false, error: 'Vault not found' };
  const error = getTransitionError(vault, 'cancelled', requesterId);
  if (error) return { success: false, error };
  vault.status = 'cancelled';
  return { success: true };
};

export const checkExpiredVaults = (): string[] => {
  const now = new Date();
  const failed: string[] = [];
  for (const vault of memoryVaults) {
    if (vault.status !== 'active') continue;
    const end = toUTCDate(vault.endTimestamp);
    if (end <= now) {
      vault.status = 'failed';
      failed.push(vault.id);
    }
  }
  return failed;
};

export const getVaultState = (vaultId: string) => {
  const vault = findVault(vaultId);
  if (!vault) return null;
  return {
    status: vault.status,
    isTerminal: TERMINAL_STATUSES.has(vault.status),
    isActive: vault.status === 'active',
  };
};

export const getAllowedNextStates = (vaultId: string): string[] => {
  const vault = findVault(vaultId);
  if (!vault) return [];
  return ALLOWED_TRANSITIONS[vault.status] || [];
};

export const transitionVaultStatus = async (
  trx: Knex.Transaction,
  vaultId: string,
  targetStatus: TerminalStatus,
): Promise<TransitionResult> => {
  const vault = await trx('vaults').where({ id: vaultId }).first()
  if (!vault) {
    return { success: false, error: 'Vault not found' }
  }

  if (TERMINAL_STATUSES.has(vault.status)) {
    return { success: false, error: `Vault is already '${vault.status}' and cannot transition` }
  }

  if (!isValidTransition(vault.status, targetStatus)) {
    const allowed = ALLOWED_TRANSITIONS[vault.status]
    return {
      success: false,
      error: `Invalid transition: '${vault.status}' -> '${targetStatus}'. Allowed: ${allowed?.join(', ') || 'none'}`
    }
  }

  await trx('vaults')
    .where({ id: vaultId })
    .update({ status: targetStatus, updated_at: new Date() })

  return { success: true }
};

export const activateVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId);
  if (!vault) return { success: false, error: 'Vault not found' };
  if (vault.status !== 'draft') {
    return { success: false, error: `Cannot activate: status is '${vault.status}', expected 'draft'` };
  }
  vault.status = 'active';
  return { success: true };
};

/**
 * Places an `active` vault into `disputed`, blocking slash and claim until resolved.
 * Only callable by an admin/guardian.
 *
 * Authorization is derived from `requesterRole`, which callers must populate from a
 * verified source (e.g. `req.user.role` set by the `authenticate` middleware from a
 * signed JWT) — never from a client-supplied value. This function does not accept a
 * caller-supplied "admin id" to compare against, since that pattern is trivially
 * bypassed if a caller ever sources both ids from the same untrusted input.
 */
export const disputeVault = (
  vaultId: string,
  requesterId: string,
  requesterRole: UserRole,
): TransitionResult => {
  if (requesterRole !== UserRole.ADMIN) {
    return { success: false, error: 'Only an admin can place a vault into disputed state' };
  }
  const vault = findVault(vaultId);
  if (!vault) return { success: false, error: 'Vault not found' };
  const allowed = ALLOWED_TRANSITIONS[vault.status];
  if (!allowed?.includes('disputed')) {
    return { success: false, error: `Cannot dispute vault in status '${vault.status}'` };
  }
  vault.status = 'disputed';
  return { success: true };
};

type DisputeResolution = 'active' | 'completed' | 'failed';

/**
 * Resolves a `disputed` vault back to `active`, or directly to `completed` / `failed`.
 * Only callable by an admin/guardian.
 *
 * See `disputeVault` above: authorization comes from a verified `requesterRole`,
 * not a caller-supplied "admin id".
 */
export const resolveDispute = (
  vaultId: string,
  requesterId: string,
  requesterRole: UserRole,
  target: DisputeResolution,
): TransitionResult => {
  if (requesterRole !== UserRole.ADMIN) {
    return { success: false, error: 'Only an admin can resolve a disputed vault' };
  }
  const vault = findVault(vaultId);
  if (!vault) return { success: false, error: 'Vault not found' };
  if (vault.status !== 'disputed') {
    return { success: false, error: `Vault is not in disputed state (current: '${vault.status}')` };
  }
  const allowed = ALLOWED_TRANSITIONS['disputed'];
  if (!allowed?.includes(target)) {
    return { success: false, error: `Invalid dispute resolution target: '${target}'` };
  }
  vault.status = target;
  return { success: true };
};
