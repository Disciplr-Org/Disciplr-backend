import { Milestone } from '../types/horizonSync.js';
import { VaultStatus as InternalVaultStatus } from '../types/vault.js';
import { EnterpriseVault, EnterpriseMilestone, VaultStatus as PublicVaultStatus } from '../types/enterprise.js';

const STATUS_MAP: Record<InternalVaultStatus, PublicVaultStatus> = {
  [InternalVaultStatus.DRAFT]: 'pending',
  [InternalVaultStatus.ACTIVE]: 'active',
  [InternalVaultStatus.COMPLETED]: 'completed',
  [InternalVaultStatus.FAILED]: 'failed',
  [InternalVaultStatus.CANCELLED]: 'cancelled',
  [InternalVaultStatus.DISPUTED]: 'active',
};

/**
 * Shape of a vault row as returned by Knex from the `vaults` table.
 * Uses the real database column names (snake_case).
 */
interface VaultDbRow {
  id: string;
  creator: string;
  amount: string;
  status: InternalVaultStatus;
  created_at: Date;
  end_date: Date;
  success_destination: string;
  failure_destination: string;
  organization_id?: string;
}

/**
 * Maps a database vault row (from Knex) to a public EnterpriseVault DTO.
 * Explicitly omits internal fields like 'created_at' and 'organization_id'.
 */
export function toPublicVault(vault: VaultDbRow): EnterpriseVault {
  return {
    id: vault.id,
    creator: vault.creator,
    amount: vault.amount,
    status: STATUS_MAP[vault.status],
    startTimestamp: vault.created_at.toISOString(),
    endTimestamp: vault.end_date.toISOString(),
    successDestination: vault.success_destination,
    failureDestination: vault.failure_destination,
  };
}

/**
 * Maps an internal Milestone model to a public EnterpriseMilestone DTO.
 */
export function toPublicMilestone(milestone: Milestone): EnterpriseMilestone {
  return {
    id: milestone.id,
    vaultId: milestone.vaultId,
    title: milestone.title,
    description: milestone.description,
    targetAmount: milestone.targetAmount,
    currentAmount: milestone.currentAmount,
    deadline: milestone.deadline.toISOString(),
    status: milestone.status,
  };
}