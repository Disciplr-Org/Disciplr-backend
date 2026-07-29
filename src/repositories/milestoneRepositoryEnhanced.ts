import { Knex } from 'knex';
import { Milestone, MilestoneStatus } from '../types/milestone.js';

export interface MilestoneEvent {
  id: string;
  userId: string;
  vaultId: string;
  name: string;
  status: 'success' | 'failed';
  timestamp: string;
}

export class MilestoneRepositoryEnhanced {
  constructor(private db: Knex) {}

  /**
   * Create a new milestone
   */
  async create(milestone: Milestone): Promise<Milestone> {
    const [created] = await this.db('milestones')
      .insert({
        ...milestone,
        // Ensure criteria is properly stringified for JSONB insertion if needed by the driver
        criteria: JSON.stringify(milestone.criteria) 
      })
      .returning('*');
    return created;
  }

  /**
   * List all milestones for a specific vault
   */
  async listByVault(vaultId: string): Promise<Milestone[]> {
    return this.db('milestones')
      .where({ vault_id: vaultId })
      .orderBy('created_at', 'asc');
  }

  /**
   * Get a milestone by ID
   */
  async getById(id: string): Promise<Milestone | undefined> {
    const [milestone] = await this.db('milestones')
      .where({ id })
      .limit(1);
    return milestone;
  }

  /**
   * Update the status of a specific milestone
   */
  async updateStatus(id: string, status: MilestoneStatus): Promise<Milestone | undefined> {
    const [updated] = await this.db('milestones')
      .where({ id })
      .update({ 
        status, 
        updated_at: this.db.fn.now() 
      })
      .returning('*');
    return updated;
  }

  /**
   * Update the criteria of a specific milestone
   */
  async updateCriteria(id: string, criteria: Record<string, any>): Promise<Milestone | undefined> {
    const [updated] = await this.db('milestones')
      .where({ id })
      .update({ 
        criteria: JSON.stringify(criteria), 
        updated_at: this.db.fn.now() 
      })
      .returning('*');
    return updated;
  }

  /**
   * Verify a milestone (set verified status and timestamp)
   */
  async verifyMilestone(id: string): Promise<Milestone | undefined> {
    const [updated] = await this.db('milestones')
      .where({ id })
      .update({ 
        status: 'approved',
        updated_at: this.db.fn.now() 
      })
      .returning('*');
    return updated;
  }

  /**
   * Check if all milestones for a vault are verified
   */
  async allVerified(vaultId: string): Promise<boolean> {
    const milestones = await this.listByVault(vaultId);
    if (milestones.length === 0) return false;
    return milestones.every((m) => m.status === 'approved');
  }

  /**
   * Add a milestone event
   */
  async addMilestoneEvent(event: Omit<MilestoneEvent, 'id'>): Promise<MilestoneEvent> {
    const [created] = await this.db('milestone_events')
      .insert({
        user_id: event.userId,
        vault_id: event.vaultId,
        name: event.name,
        status: event.status,
        timestamp: event.timestamp || this.db.fn.now()
      })
      .returning('*');
    
    return {
      id: created.id,
      userId: created.user_id,
      vaultId: created.vault_id,
      name: created.name,
      status: created.status,
      timestamp: created.timestamp
    };
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
    let query = this.db('milestone_events');

    if (opts?.userId) {
      query = query.where('user_id', opts.userId);
    }
    if (opts?.vaultId) {
      query = query.where('vault_id', opts.vaultId);
    }
    if (opts?.from) {
      query = query.where('timestamp', '>=', opts.from);
    }
    if (opts?.to) {
      query = query.where('timestamp', '<=', opts.to);
    }

    const events = await query.orderBy('timestamp', 'desc');
    
    return events.map((e: any) => ({
      id: e.id,
      userId: e.user_id,
      vaultId: e.vault_id,
      name: e.name,
      status: e.status,
      timestamp: e.timestamp
    }));
  }
}
