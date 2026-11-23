export type MilestoneStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

export interface MilestoneBase {
  id: string;
  vault_id: string;
  title: string;
  description?: string | null;
  weight: number;
  due_date?: Date | string | null;
  status?: MilestoneStatus;
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface HashMilestone extends MilestoneBase {
  type: 'hash';
  criteria: {
    hash: string;
  };
}

export interface DocumentMilestone extends MilestoneBase {
  type: 'document';
  criteria: {
    documentUrl?: string;
    documentType?: string;
  };
}

export interface OracleMilestone extends MilestoneBase {
  type: 'oracle';
  criteria: {
    oracleAddress: string;
    condition: string;
  };
}

export interface VerifierMilestone extends MilestoneBase {
  type: 'verifier';
  criteria: {
    verifierId: string;
  };
}

export type Milestone =
  | HashMilestone
  | DocumentMilestone
  | OracleMilestone
  | VerifierMilestone;