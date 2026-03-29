import { db } from '../db/knex.js'
import { MilestoneRepository } from '../repositories/milestoneRepository.js'
import { getTransitionError } from './milestoneTransitions.js'
import type { Milestone, MilestoneStatus, TransitionResult } from '../types/milestone.js'

// ─── Repository instance ────────────────────────────────────────────

let repo = new MilestoneRepository(db)

/** Exposed for test injection */
export const _getRepository = (): MilestoneRepository => repo
export const _setRepository = (r: MilestoneRepository): void => { repo = r }

// ─── Milestone CRUD & transitions ───────────────────────────────────

export const createMilestone = async (
  data: Omit<Milestone, 'created_at' | 'updated_at'>,
): Promise<Milestone> => {
  return repo.create(data)
}

export const getMilestoneById = async (id: string): Promise<Milestone | undefined> => {
  return repo.getById(id)
}

export const getMilestonesByVaultId = async (vaultId: string): Promise<Milestone[]> => {
  return repo.listByVault(vaultId)
}

export const transitionMilestone = async (
  id: string,
  targetStatus: MilestoneStatus,
): Promise<TransitionResult & { milestone?: Milestone }> => {
  const milestone = await repo.getById(id)
  if (!milestone) return { success: false, error: 'Milestone not found' }

  const error = getTransitionError(milestone.status, targetStatus)
  if (error) {
    console.warn(`[Milestones] Transition rejected: milestone=${id} from=${milestone.status} to=${targetStatus} reason="${error}"`)
    return { success: false, error }
  }

  const updated = await repo.updateStatus(id, targetStatus)
  if (!updated) return { success: false, error: 'Failed to update milestone' }

  console.info(`[Milestones] Transition OK: milestone=${id} vault=${milestone.vault_id} from=${milestone.status} to=${targetStatus}`)
  return { success: true, milestone: updated }
}

export const allMilestonesCompleted = async (vaultId: string): Promise<boolean> => {
  return repo.allCompletedByVault(vaultId)
}

// ─── In-memory milestone analytics (kept as separate concern) ───────

export type MilestoneEventStatus = 'success' | 'failed'
export interface MilestoneEvent {
  id: string
  userId: string
  vaultId: string
  name: string
  status: MilestoneEventStatus
  timestamp: string
}

let milestoneEvents: MilestoneEvent[] = []

export const resetMilestoneEvents = (): void => {
  milestoneEvents = []
}

export const addMilestoneEvent = (event: Omit<MilestoneEvent, 'id'>): MilestoneEvent => {
  const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const record: MilestoneEvent = { id, ...event }
  milestoneEvents.push(record)
  return record
}

export const listMilestoneEvents = (opts?: {
  userId?: string
  vaultId?: string
  from?: string
  to?: string
}): MilestoneEvent[] => {
  let result = [...milestoneEvents]
  if (opts?.userId) result = result.filter((e) => e.userId === opts.userId)
  if (opts?.vaultId) result = result.filter((e) => e.vaultId === opts.vaultId)
  if (opts?.from) {
    const fromTs = new Date(opts.from).getTime()
    result = result.filter((e) => new Date(e.timestamp).getTime() >= fromTs)
  }
  if (opts?.to) {
    const toTs = new Date(opts.to).getTime()
    result = result.filter((e) => new Date(e.timestamp).getTime() <= toTs)
  }
  return result
}
