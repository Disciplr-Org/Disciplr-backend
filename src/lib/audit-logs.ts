export type AuditLog = {
  id: string
  actor_user_id: string
  action: string
  target_type: string
  target_id: string
  metadata: Record<string, unknown>
  created_at: string
}

type AuditLogFilters = {
  actor_user_id?: string
  action?: string
  target_type?: string
  target_id?: string
  limit?: number
}

const auditLogsTable: AuditLog[] = []

const makeId = (): string => `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

export const createAuditLog = (entry: Omit<AuditLog, 'id' | 'created_at'>): AuditLog => {
  const created_at = new Date().toISOString()
  const auditLog: AuditLog = {
    id: makeId(),
    created_at,
    ...entry,
  }

  auditLogsTable.push(auditLog)
  return auditLog
}

export const listAuditLogs = (filters: AuditLogFilters = {}): AuditLog[] => {
  const parsedLimit = Number(filters.limit)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 100

  return auditLogsTable
    .filter((log) => (filters.actor_user_id ? log.actor_user_id === filters.actor_user_id : true))
    .filter((log) => (filters.action ? log.action === filters.action : true))
    .filter((log) => (filters.target_type ? log.target_type === filters.target_type : true))
    .filter((log) => (filters.target_id ? log.target_id === filters.target_id : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
}

export const getAuditLogById = (id: string): AuditLog | undefined =>
  auditLogsTable.find((log) => log.id === id)
