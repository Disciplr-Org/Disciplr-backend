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
