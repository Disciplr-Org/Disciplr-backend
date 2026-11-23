import { Knex } from 'knex';
import { Milestone, MilestoneStatus } from '../types/milestone.js';
import { randomUUID } from 'node:crypto';

export interface MilestoneEvent {
  id: string;
  userId: string;
  vaultId: string;
  name: string;
  status: 'success' | 'failed';
  timestamp?: string;
}

export class MilestoneRepositoryEnhanced {
  constructor(private db: Knex) {}

  async create(milestone: Milestone): Promise<Milestone> {
    const [created] = await this.db('milestones')
      .insert({
        ...milestone,
        criteria: JSON.stringify(milestone.criteria)
      })
      .returning('*');
    return created;
  }

  async listByVault(vaultId: string, trx?: Knex.Transaction): Promise<Milestone[]> {
    const client = trx ?? this.db
    return client('milestones')
      .where({ vault_id: vaultId })
      .orderBy('created_at', 'asc');
  }

  async getById(id: string, trx?: Knex.Transaction): Promise<Milestone | undefined> {
    const client = trx ?? this.db
    const [milestone] = await client('milestones')
      .where({ id })
      .limit(1);
    return milestone;
  }

  async updateStatus(id: string, status: MilestoneStatus, trx?: Knex.Transaction): Promise<Milestone | undefined> {
    const client = trx ?? this.db
    const [updated] = await client('milestones')
      .where({ id })
      .update({ 
        status, 
        updated_at: client.fn.now() 
      })
      .returning('*');
    return updated;
  }

  async updateCriteria(id: string, criteria: Record<string, any>, trx?: Knex.Transaction): Promise<Milestone | undefined> {
    const client = trx ?? this.db
    const [updated] = await client('milestones')
      .where({ id })
      .update({ 
        criteria: JSON.stringify(criteria), 
        updated_at: client.fn.now() 
      })
      .returning('*');
    return updated;
  }

  async verifyMilestone(id: string, trx?: Knex.Transaction): Promise<Milestone | undefined> {
    const client = trx ?? this.db
    const [updated] = await client('milestones')
      .where({ id })
      .update({ 
        status: 'approved',
        updated_at: client.fn.now() 
      })
      .returning('*');
    return updated;
  }

  async allVerified(vaultId: string, trx?: Knex.Transaction): Promise<boolean> {
    const milestones = await this.listByVault(vaultId, trx);
    if (milestones.length === 0) return false;
    return milestones.every((m) => m.status === 'approved');
  }

  async allMetThreshold(
    vaultId: string,
    approvalCounts: Record<string, number>,
    rejectionCounts: Record<string, number> = {},
    totalVerifierCounts: Record<string, number> = {},
    trx?: Knex.Transaction,
  ): Promise<boolean> {
    const vaultMilestones = await this.listByVault(vaultId, trx)
    if (vaultMilestones.length === 0) return false

    return vaultMilestones.every((m) => {
      const threshold = (m.criteria && typeof m.criteria === 'object' && 'approvalThreshold' in m.criteria)
        ? (m.criteria as any).approvalThreshold
        : 1
      const approved = approvalCounts[m.id] || 0
      const rejected = rejectionCounts[m.id] || 0
      const n = totalVerifierCounts[m.id]

      if (n !== undefined && n > 0) {
        const totalVoted = approved + rejected
        const remaining = Math.max(n - totalVoted, 0)
        const maxPossible = approved + remaining
        if (maxPossible < threshold) return false
      } else {
        if (rejected > 0) return false
      }

      return approved >= threshold
    })
  }

  async addMilestoneEvent(event: Omit<MilestoneEvent, 'id'>, trx?: Knex.Transaction): Promise<MilestoneEvent> {
    const client = trx ?? this.db
    const [created] = await client('milestone_events')
      .insert({
        user_id: event.userId,
        vault_id: event.vaultId,
        name: event.name,
        status: event.status,
        timestamp: event.timestamp || client.fn.now()
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

  async listMilestoneEvents(opts?: {
    userId?: string;
    vaultId?: string;
    from?: string;
    to?: string;
  }, trx?: Knex.Transaction): Promise<MilestoneEvent[]> {
    const client = trx ?? this.db
    let query = client('milestone_events');

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

  async verifyMilestoneAtomic(
    id: string,
    verifierUserId: string,
    evidenceHash?: string,
    trx?: Knex.Transaction,
  ): Promise<Milestone | null> {
    const client = trx ?? this.db
    const existing = await client('milestones').where({ id }).first()
    if (!existing) return null

    if (existing.status === 'approved') {
      await client('milestone_events').insert({
        user_id: verifierUserId,
        vault_id: existing.vault_id,
        name: 'milestone.verified',
        status: 'success',
        timestamp: client.fn.now(),
      })
      return existing as Milestone
    }

    const criteria = this.parseCriteria(existing.criteria)
    const updatedCriteria = {
      ...criteria,
      verifiedBy: verifierUserId,
      ...(evidenceHash ? { evidenceHash } : {}),
    }

    const [updated] = await client('milestones')
      .where({ id })
      .update({
        status: 'approved',
        updated_at: client.fn.now(),
        criteria: JSON.stringify(updatedCriteria),
      })
      .returning('*')

    await client('milestone_events').insert({
      user_id: verifierUserId,
      vault_id: updated.vault_id,
      name: 'milestone.verified',
      status: 'success',
      timestamp: client.fn.now(),
    })

    return updated as Milestone
  }

  async approveMilestoneAtomic(
    id: string,
    verifiedBy: string,
    trx?: Knex.Transaction,
  ): Promise<Milestone | null> {
    const client = trx ?? this.db
    const existing = await client('milestones').where({ id }).first()
    if (!existing) return null

    if (existing.status === 'approved') {
      return existing as Milestone
    }

    const [updated] = await client('milestones')
      .where({ id })
      .update({
        status: 'approved',
        updated_at: client.fn.now(),
      })
      .returning('*')

    await client('milestone_events').insert({
      user_id: verifiedBy,
      vault_id: updated.vault_id,
      name: 'milestone.approved',
      status: 'success',
      timestamp: client.fn.now(),
    })

    return updated as Milestone
  }

  private parseCriteria(criteria: any): Record<string, any> {
    if (!criteria) return {}
    if (typeof criteria === 'string') {
      try { return JSON.parse(criteria) } catch { return {} }
    }
    return criteria
  }
}
