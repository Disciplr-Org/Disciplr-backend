export enum VaultStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  DISPUTED = 'disputed'
}

/**
 * Matches the real vaults table schema after all migrations:
 *   initial_baseline: id, creator, amount, start_date (was start_timestamp),
 *                     end_date (was end_timestamp), success_destination,
 *                     failure_destination, status, created_at
 *   fix_vault_schema:  adds verifier, updated_at
 */
export interface Vault {
  id: string;
  creator: string;
  amount: string;
  start_date: Date;
  end_date: Date;
  verifier: string | null;
  success_destination: string;
  failure_destination: string;
  status: VaultStatus;
  organization_id?: string;
  created_at: Date;
  updated_at: Date;
}

export type CreateVaultDTO = {
  id: string;
  creator: string;
  amount: string;
  startDate: Date | string;
  endDate: Date | string;
  verifier?: string | null;
  successDestination: string;
  failureDestination: string;
  status?: VaultStatus;
};

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
    status: VaultStatus
}
