import { Knex } from 'knex'
import { Milestone, MilestoneStatus } from '../types/milestone.js'

export class MilestoneRepository {
  constructor(private db: Knex) {}

  async create(milestone: Omit<Milestone, 'created_at' | 'updated_at'>): Promise<Milestone> {
    const [created] = await this.db('milestones')
      .insert(milestone)
      .returning('*')
    return created
  }

  async getById(id: string): Promise<Milestone | undefined> {
    return this.db('milestones').where({ id }).first()
  }

  async listByVault(vaultId: string): Promise<Milestone[]> {
    return this.db('milestones')
      .where({ vault_id: vaultId })
      .orderBy('created_at', 'asc')
  }

  async updateStatus(id: string, status: MilestoneStatus): Promise<Milestone | undefined> {
    const [updated] = await this.db('milestones')
      .where({ id })
      .update({
        status,
        updated_at: this.db.fn.now(),
      })
      .returning('*')
    return updated
  }

  async allCompletedByVault(vaultId: string): Promise<boolean> {
    const milestones = await this.listByVault(vaultId)
    if (milestones.length === 0) return false
    return milestones.every((m) => m.status === 'completed')
  }
}
