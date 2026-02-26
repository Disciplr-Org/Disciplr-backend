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
export interface Vault {
    id: string
    creator: string
    amount: string
    startTimestamp: string
    endTimestamp: string
    successDestination: string
    failureDestination: string
    status: 'active' | 'completed' | 'failed' | 'cancelled'
    createdAt: string
    updatedAt: string
}

export interface VaultAnalytics {
    totalVaults: number
    activeVaults: number
    completedVaults: number
    failedVaults: number
    totalLockedCapital: string
    activeCapital: string
    successRate: number
    lastUpdated: string
}

export interface VaultAnalyticsWithPeriod extends VaultAnalytics {
    period: string
    startDate: string
    endDate: string
}

export interface TimeRangeFilter {
    period: '7d' | '30d' | '90d' | '1y' | 'all'
}

export interface VaultStatusUpdate {
    status: 'active' | 'completed' | 'failed' | 'cancelled'
}
