export enum VaultStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}

export interface Vault {
  id: string;
  contract_id: string | null;
  creator_address: string;
  amount: string; 
  milestone_hash: string;
  verifier_address: string;
  success_destination: string;
  failure_destination: string;
  status: VaultStatus;
  deadline: Date;
  created_at: Date;
  updated_at: Date;
}

export type CreateVaultDTO = {
  contractId?: string;
  creatorAddress: string;
  amount: string;
  milestoneHash: string;
  verifierAddress: string;
  successDestination: string;
  failureDestination: string;
  deadline: Date | string;
};