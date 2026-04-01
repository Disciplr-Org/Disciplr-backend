import { Milestone } from '../types/horizonSync';
import { Vault } from '../types/vault';
import { EnterpriseVault, EnterpriseMilestone } from '../types/enterprise';

/**
 * Maps an internal Vault model to a public EnterpriseVault DTO.
 * Explicitly omits internal fields like 'created_at'.
 */
export function toPublicVault(vault: Vault): EnterpriseVault {
  return {
    id: vault.id,
    creator: vault.creator_address,
    amount: vault.amount,
    status: vault.status,
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