export type MilestoneStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

export interface Milestone {
  id: string;
  vault_id: string;
  title: string;
  description?: string | null;
  type: string;
  // JSONB criteria (hash/document/oracle/verifier configuration)
  criteria: Record<string, any>;
  weight: number;
  due_date?: Date | string | null;
  status?: MilestoneStatus;
  created_at?: Date | string;
  updated_at?: Date | string;
}