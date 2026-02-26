import { Knex } from 'knex';
import { Milestone, MilestoneStatus } from '../types/milestone.js';

export class MilestoneRepository {
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
}