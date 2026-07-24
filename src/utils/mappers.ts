import { Milestone } from '../types/horizonSync.js';
import { Vault, VaultStatus as InternalVaultStatus } from '../types/vault.js';
import { EnterpriseVault, EnterpriseMilestone, VaultStatus as PublicVaultStatus } from '../types/enterprise.js';

const STATUS_MAP: Record<InternalVaultStatus, PublicVaultStatus> = {
  [InternalVaultStatus.PENDING]: 'pending',
  [InternalVaultStatus.ACTIVE]: 'active',
  [InternalVaultStatus.COMPLETED]: 'completed',
  [InternalVaultStatus.FAILED]: 'failed',
  [InternalVaultStatus.CANCELLED]: 'cancelled',
};

/**
 * Maps an internal Vault model to a public EnterpriseVault DTO.
 * Explicitly omits internal fields like 'created_at'.
 */
export function toPublicVault(vault: Vault): EnterpriseVault {
  return {
    id: vault.id,
    creator: vault.creator_address,
    amount: vault.amount,
    status: STATUS_MAP[vault.status],
    startTimestamp: vault.created_at.toISOString(),
    endTimestamp: vault.deadline.toISOString(),
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