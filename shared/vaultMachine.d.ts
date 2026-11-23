// Type declarations for shared/vaultMachine.mjs, consumed by the TypeScript
// monolith (src/) and editors. Runtime stays plain ESM so the deployed API can
// import the same file without a build step.
export type VaultStatus = 'draft' | 'active' | 'completed' | 'failed' | 'cancelled' | 'disputed';

export type MilestoneStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface Milestone {
  id: string;
  status: MilestoneStatus;
  title?: string;
  amount?: string | number;
  [key: string]: unknown;
}

export interface Vault {
  id: string;
  status: VaultStatus;
  amount?: string | number;
  milestones: Milestone[];
  [key: string]: unknown;
}

export interface Activity {
  id: string;
  type: 'validate' | 'release' | 'redirect';
  vaultId: string;
  amount: string | number | undefined;
  status: 'simulated';
  hash: string;
  memo: string;
  createdAt: string;
}

export interface ActivityDeps {
  /** Generates activity ids. Defaults to `crypto.randomUUID()`. */
  id?: () => string;
  /** Generates the simulated chain hash. */
  hash?: () => string;
}

export type MachineErrorCode =
  | 'VAULT_NOT_FOUND'
  | 'VAULT_NOT_ACTIVE'
  | 'MILESTONE_NOT_FOUND'
  | 'MILESTONE_ALREADY_COMPLETED'
  | 'MILESTONE_NOT_PENDING';

export interface MachineSuccess {
  ok: true;
  vault: Vault;
  activities: Activity[];
}

export interface MachineFailure {
  ok: false;
  code: MachineErrorCode;
  httpStatus: number;
  message: string;
}

export type MachineResult = MachineSuccess | MachineFailure;

/**
 * Vault-level transition table aligned with the on-chain `VaultStatus` enum.
 * Terminal states map to empty lists.
 */
export declare const VAULT_TRANSITIONS: Readonly<Record<string, readonly VaultStatus[]>>;

export declare function canTransition(from: string, to: string): boolean;

export declare function validateMilestone(
  vault: Vault | null | undefined,
  milestoneId: string,
  now?: Date | string | number,
  deps?: ActivityDeps,
): MachineResult;

export declare function failVault(
  vault: Vault | null | undefined,
  now?: Date | string | number,
  deps?: ActivityDeps,
): MachineResult;
