import { MilestoneRepositoryEnhanced, MilestoneEvent } from '../repositories/milestoneRepositoryEnhanced.js';

export interface Milestone {
  id: string;
  vaultId: string;
  description: string;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

export class MilestoneService {
  constructor(private repository: MilestoneRepositoryEnhanced) {}

  /**
   * Create a new milestone
   */
  async createMilestone(vaultId: string, description: string): Promise<Milestone> {
    const id = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const milestone = {
      id,
      vault_id: vaultId,
      title: description, // Using description as title for now
      description,
      // 'document' is the only milestone variant whose criteria fields are all
      // optional, making it the fit for free-form description milestones.
      type: 'document' as const,
      criteria: {},
      weight: 1,
      status: 'pending' as const,
      created_at: new Date().toISOString(),
    };

    const created = await this.repository.create(milestone);
    
    return {
      id: created.id,
      vaultId: created.vault_id,
      description: created.description || '',
      verified: created.status === 'approved',
      verifiedAt: created.status === 'approved' ? (created.updated_at?.toString() ?? null) : null,
      createdAt: created.created_at?.toString() ?? new Date().toISOString(),
    };
  }

  /**
   * Get all milestones for a specific vault
   */
  async getMilestonesByVaultId(vaultId: string): Promise<Milestone[]> {
    const milestones = await this.repository.listByVault(vaultId);
    
    return milestones.map((m) => ({
      id: m.id,
      vaultId: m.vault_id,
      description: m.description || '',
      verified: m.status === 'approved',
      verifiedAt: m.status === 'approved' ? (m.updated_at?.toString() ?? null) : null,
      createdAt: m.created_at?.toString() ?? new Date().toISOString(),
    }));
  }

  /**
   * Get a milestone by ID
   */
  async getMilestoneById(id: string): Promise<Milestone | undefined> {
    const milestone = await this.repository.getById(id);
    if (!milestone) return undefined;
    
    return {
      id: milestone.id,
      vaultId: milestone.vault_id,
      description: milestone.description || '',
      verified: milestone.status === 'approved',
      verifiedAt: milestone.status === 'approved' ? (milestone.updated_at?.toString() ?? null) : null,
      createdAt: milestone.created_at?.toString() ?? new Date().toISOString(),
    };
  }

  /**
   * Verify a milestone
   */
  async verifyMilestone(id: string): Promise<Milestone | null> {
    const verified = await this.repository.verifyMilestone(id);
    if (!verified) return null;
    
    return {
      id: verified.id,
      vaultId: verified.vault_id,
      description: verified.description || '',
      verified: true,
      verifiedAt: verified.updated_at?.toString() ?? new Date().toISOString(),
      createdAt: verified.created_at?.toString() ?? new Date().toISOString(),
    };
  }

  /**
   * Check if all milestones for a vault are verified
   */
  async allMilestonesVerified(vaultId: string): Promise<boolean> {
    return this.repository.allVerified(vaultId);
  }

  /**
   * Add a milestone event
   */
  async addMilestoneEvent(event: Omit<MilestoneEvent, 'id'>): Promise<MilestoneEvent> {
    return this.repository.addMilestoneEvent(event);
  }

  /**
   * List milestone events with optional filters
   */
  async listMilestoneEvents(opts?: {
    userId?: string;
    vaultId?: string;
    from?: string;
    to?: string;
  }): Promise<MilestoneEvent[]> {
    return this.repository.listMilestoneEvents(opts);
  }
}
