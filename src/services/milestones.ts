export interface Milestone {
  id: string
  vaultId: string
  description: string
  verified: boolean
  verifiedAt: string | null
  createdAt: string
}

const milestonesTable: Milestone[] = []

export const createMilestone = (vaultId: string, description: string): Milestone => {
  const id = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const milestone: Milestone = {
    id,
    vaultId,
    description,
    verified: false,
    verifiedAt: null,
    createdAt: new Date().toISOString(),
  }
  milestonesTable.push(milestone)
  return milestone
}

export const getMilestonesByVaultId = (vaultId: string): Milestone[] => {
  return milestonesTable.filter((m) => m.vaultId === vaultId)
}

export const getMilestoneById = (id: string): Milestone | undefined => {
  return milestonesTable.find((m) => m.id === id)
}

export const verifyMilestone = (id: string): Milestone | null => {
  const milestone = milestonesTable.find((m) => m.id === id)
  if (!milestone) return null

  milestone.verified = true
  milestone.verifiedAt = new Date().toISOString()
  return milestone
}

export const allMilestonesVerified = (vaultId: string): boolean => {
  const milestonesList = getMilestonesByVaultId(vaultId)
  if (milestonesList.length === 0) return false
  return milestonesList.every((m) => m.verified)
}

export const resetMilestonesTable = (): void => {
  milestonesTable.length = 0
}

export type MilestoneStatus = 'success' | 'failed'
export interface MilestoneEvent {
  id: string
  userId: string
  vaultId: string
  name: string
  status: MilestoneStatus
  timestamp: string
}

let milestones: MilestoneEvent[] = []

export const resetMilestones = (): void => {
  milestones = []
}

export const addMilestoneEvent = (event: Omit<MilestoneEvent, 'id'>): MilestoneEvent => {
  const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const record: MilestoneEvent = { id, ...event }
  milestones.push(record)
  return record
}

export const listMilestoneEvents = (opts?: {
  userId?: string
  vaultId?: string
  from?: string
  to?: string
}): MilestoneEvent[] => {
  let result = [...milestones]
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
