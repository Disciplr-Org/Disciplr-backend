/**
 * Public DTOs for the Enterprise API.
 * These types define the strict contract for external consumption,
 * ensuring internal database metadata is omitted.
 */

export type VaultStatus = 'active' | 'completed' | 'failed' | 'cancelled';
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface EnterpriseVault {
  id: string;
  creator: string;
  amount: string;
  status: VaultStatus;
  startTimestamp: string;
  endTimestamp: string;
  successDestination: string;
  failureDestination: string;
}

export interface EnterpriseMilestone {
  id: string;
  vaultId: string;
  title: string;
  description: string | null;
  targetAmount: string;
  currentAmount: string;
  deadline: string;
  status: MilestoneStatus;
}

export type EnterpriseResponse<T> = T | { data: T };

export interface Organization {
  id: string;
  name: string;
  slug: string;
  metadata?: Record<string, unknown> | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  metadata?: Record<string, unknown>;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  organization_id: string;
  metadata?: Record<string, unknown> | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface CreateTeamInput {
  name: string;
  slug: string;
  organization_id: string;
  metadata?: Record<string, unknown>;
}

export interface Membership {
  id: string;
  user_id: string;
  organization_id: string;
  team_id?: string | null;
  role: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface CreateMembershipInput {
  user_id: string;
  organization_id: string;
  team_id?: string | null;
  role?: string;
}