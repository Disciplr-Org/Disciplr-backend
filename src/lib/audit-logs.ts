import { db } from '../db/knex.js'
import type { Knex } from 'knex'
import { createHash } from 'crypto'
import { redact } from '../middleware/privacy-logger.js'

export type AuditLogMetadata = Record<string, unknown>

export type AuditLog = {
  id: string
  actor_user_id: string
  organization_id?: string
  action: string
  target_type: string
  target_id: string
  metadata: AuditLogMetadata
  created_at: string
  prev_hash?: string | null
  row_hash?: string | null
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

export const AUDIT_LOG_GENESIS_HASH = '0'.repeat(64)

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

const normalizeTimestamp = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

const normalizeJson = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalizeJson)

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = normalizeJson((value as Record<string, unknown>)[key])
      return acc
    }, {})
}

const stableStringify = (value: unknown): string => JSON.stringify(normalizeJson(value))

export const canonicalizeAuditLogRow = (row: AuditLog): string =>
  stableStringify({
    id: row.id,
    actor_user_id: row.actor_user_id,
    organization_id: row.organization_id ?? null,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    metadata: row.metadata ?? {},
    created_at: normalizeTimestamp(row.created_at),
  })

export const hashAuditLogRow = (prevHash: string | null | undefined, row: AuditLog): string =>
  createHash('sha256')
    .update(stableStringify({
      prev_hash: prevHash ?? AUDIT_LOG_GENESIS_HASH,
      canonical_row: canonicalizeAuditLogRow(row),
    }))
    .digest('hex')

const getOrganizationChainKey = (organizationId?: string | null): string | null =>
  typeof organizationId === 'string' && organizationId.trim() !== '' ? organizationId : null

const getPreviousHash = async (
  trx: Knex.Transaction,
  organizationId?: string | null,
): Promise<string> => {
  const chainKey = getOrganizationChainKey(organizationId)
  let query = trx('audit_logs')
    .select('row_hash')
    .whereNotNull('row_hash')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .forUpdate()

  query = chainKey === null ? query.whereNull('organization_id') : query.where('organization_id', chainKey)

  const previous = await query.first()
  return previous?.row_hash ?? AUDIT_LOG_GENESIS_HASH
}

export const createAuditLog = async (
  entry: Omit<AuditLog, 'id' | 'created_at'> & { organization_id?: string },
): Promise<AuditLog> => {
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

  return await db.transaction(async (trx) => {
    const prevHash = await getPreviousHash(trx, auditLog.organization_id)
    const rowHash = hashAuditLogRow(prevHash, auditLog)

    const insertPayload: Record<string, unknown> = {
      id: auditLog.id,
      actor_user_id: auditLog.actor_user_id,
      action: auditLog.action,
      target_type: auditLog.target_type,
      target_id: auditLog.target_id,
      metadata: auditLog.metadata,
      created_at: auditLog.created_at,
      prev_hash: prevHash,
      row_hash: rowHash,
    }

    if (typeof auditLog.organization_id !== 'undefined') {
      insertPayload.organization_id = auditLog.organization_id
    }

    const [insertedLog] = await trx('audit_logs').insert(insertPayload).returning('*')
    return insertedLog
  })
}

export const listAuditLogs = async (filters: AuditLogFilters = {}): Promise<AuditLog[]> => {
  const parsedLimit = Number(filters.limit)
  const parsedOffset = Number(filters.offset)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 100
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0

  let query = db('audit_logs')
    .select('*')
    // Default ordering is most-recent-first; allow admin API to pass filtered WHERE clauses that
    // can leverage a composite (organization_id, created_at) index when present.
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)

  // Apply filters efficiently using indexes
  if (filters.actor_user_id) {
    query = query.where('actor_user_id', filters.actor_user_id)
  }
  if ((filters as any).organization_id) {
    query = query.where('organization_id', (filters as any).organization_id)
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

export type AuditLogIntegrityFailure = {
  id: string
  index: number
  reason: 'missing_hash' | 'prev_hash_mismatch' | 'row_hash_mismatch'
  expected?: string
  actual?: string | null
}

export type AuditLogVerificationResult = {
  organization_id: string | null
  verified: boolean
  checked_count: number
  head_hash: string
  tail_hash: string
  failures: AuditLogIntegrityFailure[]
}

export const verifyAuditLogChain = async (
  organizationId?: string | null,
): Promise<AuditLogVerificationResult> => {
  const chainKey = getOrganizationChainKey(organizationId)
  let query = db('audit_logs').select('*').orderBy('created_at', 'asc').orderBy('id', 'asc')
  query = chainKey === null ? query.whereNull('organization_id') : query.where('organization_id', chainKey)

  const rows = await query
  let expectedPrevHash = AUDIT_LOG_GENESIS_HASH
  const failures: AuditLogIntegrityFailure[] = []

  rows.forEach((row: AuditLog, index: number) => {
    if (!row.prev_hash || !row.row_hash) {
      failures.push({
        id: row.id,
        index,
        reason: 'missing_hash',
      })
      expectedPrevHash = row.row_hash ?? expectedPrevHash
      return
    }

    if (row.prev_hash !== expectedPrevHash) {
      failures.push({
        id: row.id,
        index,
        reason: 'prev_hash_mismatch',
        expected: expectedPrevHash,
        actual: row.prev_hash,
      })
    }

    const expectedRowHash = hashAuditLogRow(row.prev_hash, row)
    if (row.row_hash !== expectedRowHash) {
      failures.push({
        id: row.id,
        index,
        reason: 'row_hash_mismatch',
        expected: expectedRowHash,
        actual: row.row_hash,
      })
    }

    expectedPrevHash = row.row_hash
  })

  return {
    organization_id: chainKey,
    verified: failures.length === 0,
    checked_count: rows.length,
    head_hash: rows[0]?.row_hash ?? AUDIT_LOG_GENESIS_HASH,
    tail_hash: rows[rows.length - 1]?.row_hash ?? AUDIT_LOG_GENESIS_HASH,
    failures,
  }
}

export type AuditLogExport = {
  organization_id: string
  exported_at: string
  chain: AuditLogVerificationResult
  audit_logs: AuditLog[]
  proof: Array<{
    id: string
    prev_hash: string | null
    row_hash: string | null
  }>
}

export const exportAuditLogsForOrganization = async (organizationId: string): Promise<AuditLogExport> => {
  const rows = await db('audit_logs')
    .select('*')
    .where('organization_id', organizationId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')

  const chain = await verifyAuditLogChain(organizationId)
  const redactedRows = redact(rows) as AuditLog[]

  return {
    organization_id: organizationId,
    exported_at: new Date().toISOString(),
    chain,
    audit_logs: redactedRows,
    proof: rows.map((row: AuditLog) => ({
      id: row.id,
      prev_hash: row.prev_hash ?? null,
      row_hash: row.row_hash ?? null,
    })),
  }
}

// Testing helper - clear audit logs for test isolation
export const clearAuditLogs = async (): Promise<void> => {
  await db('audit_logs').del()
}
