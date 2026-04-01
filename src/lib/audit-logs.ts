export type AuditLogMetadata = Record<string, unknown>

export type AuditLog = {
  id: string
  actor_user_id: string
  action: string
  target_type: string
  target_id: string
  metadata: AuditLogMetadata
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

const toSnakeCase = (input: string): string =>
  input
    .replace(/([A-Z])/g, '_$1')
    .replace(/[\s-]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase()

const isSensitiveKey = (key: string): boolean =>
  /(password|token|refresh[_-]?token|email|ssn|credit|card|ip)/i.test(key)

const sanitizeMetadataValue = (key: string, value: unknown): unknown => {
  if (typeof value === 'string') {
    if (/^(?:\d+\.){3}\d+$/.test(value)) {
      return '[redacted]'
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return '[redacted]'
    }
  }
  return value
}

const sanitizeMetadata = (metadata: Record<string, unknown> = {}): AuditLogMetadata => {
  const normalized: AuditLogMetadata = {}

  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    if (rawKey.trim() === '' || isSensitiveKey(rawKey)) {
      continue
    }

    const key = toSnakeCase(rawKey)

    if (key.trim() === '' || isSensitiveKey(key)) {
      continue
    }

    normalized[key] = sanitizeMetadataValue(key, rawValue)
  }

  return normalized
}

export const createAuditLog = (entry: Omit<AuditLog, 'id' | 'created_at'>): AuditLog => {
  if (!entry.actor_user_id || !entry.action || !entry.target_type || !entry.target_id) {
    throw new Error('Invalid audit log entry: missing required fields')
  }

  const sanitizedMetadata = sanitizeMetadata(entry.metadata ?? {})

  const normalizedMetadata = {
    ...sanitizedMetadata,
    ...(entry.actor_user_id !== 'system' && !('admin_id' in sanitizedMetadata)
      ? { admin_id: entry.actor_user_id }
      : {}),
  }

  const created_at = new Date().toISOString()
  const auditLog: AuditLog = {
    id: makeId(),
    created_at,
    ...entry,
    metadata: normalizedMetadata,
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

// Testing helper - keep audits in-memory and easily reset for test isolation
export const clearAuditLogs = (): void => {
  auditLogsTable.length = 0
}
