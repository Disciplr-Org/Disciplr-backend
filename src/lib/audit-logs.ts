import { db } from '../db/knex.js'

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

export type AuditLogFilters = {
  actor_user_id?: string
  action?: string
  target_type?: string
  target_id?: string
  limit?: number
  offset?: number
}

const makeId = (): string => `audit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

const toSnakeCase = (input: string): string =>
  input
    .replace(/([A-Z])/g, '_$1')
    .replace(/[\s-]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase()

const isSensitiveKey = (key: string): boolean =>
  /(password|token|refresh[_-]?token|email|ssn|credit|card|ip|secret|key|auth)/i.test(key)

const sanitizeMetadataValue = (key: string, value: unknown): unknown => {
  if (typeof value === 'string') {
    if (/^(?:\d+\.){3}\d+$/.test(value)) {
      return '[redacted]'
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return '[redacted]'
    }
    // Redact potential tokens/secrets (long alphanumeric strings)
    if (/^[A-Za-z0-9]{32,}$/.test(value)) {
      return '[redacted]'
    }
  }
  // Recursively sanitize nested objects
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return sanitizeMetadata(value as Record<string, unknown>)
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

export const createAuditLog = async (entry: Omit<AuditLog, 'id' | 'created_at'>): Promise<AuditLog> => {
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

  // Insert into database
  const [insertedLog] = await db('audit_logs')
    .insert({
      id: auditLog.id,
      actor_user_id: auditLog.actor_user_id,
      action: auditLog.action,
      target_type: auditLog.target_type,
      target_id: auditLog.target_id,
      metadata: auditLog.metadata,
      created_at: auditLog.created_at,
    })
    .returning('*')

  return insertedLog
}

export const listAuditLogs = async (filters: AuditLogFilters = {}): Promise<AuditLog[]> => {
  const parsedLimit = Number(filters.limit)
  const parsedOffset = Number(filters.offset)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 100
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0

  let query = db('audit_logs')
    .select('*')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)

  // Apply filters efficiently using indexes
  if (filters.actor_user_id) {
    query = query.where('actor_user_id', filters.actor_user_id)
  }
  if (filters.action) {
    query = query.where('action', filters.action)
  }
  if (filters.target_type) {
    query = query.where('target_type', filters.target_type)
  }
  if (filters.target_id) {
    query = query.where('target_id', filters.target_id)
  }

  return await query
}

export const getAuditLogById = async (id: string): Promise<AuditLog | undefined> => {
  const log = await db('audit_logs')
    .select('*')
    .where('id', id)
    .first()
  
  return log || undefined
}

// Testing helper - clear audit logs for test isolation
export const clearAuditLogs = async (): Promise<void> => {
  await db('audit_logs').del()
}
