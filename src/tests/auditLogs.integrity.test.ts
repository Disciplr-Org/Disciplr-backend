import { describe, it, expect, beforeEach, afterAll } from '@jest/globals'
import { db, closeDatabase } from '../db/knex.js'
import {
  AUDIT_LOG_GENESIS_HASH,
  clearAuditLogs,
  createAuditLog,
  exportAuditLogsForOrganization,
  hashAuditLogRow,
  verifyAuditLogChain,
} from '../lib/audit-logs.js'

const organizationId = '00000000-0000-4000-8000-000000000684'

const createOrgAuditLog = (index: number) =>
  createAuditLog({
    actor_user_id: `user-${index}`,
    organization_id: organizationId,
    action: 'vault.updated',
    target_type: 'vault',
    target_id: `vault-${index}`,
    metadata: {
      index,
      safe_note: `kept-${index}`,
      email: `person-${index}@example.com`,
      nested: {
        token: 'a'.repeat(40),
        visible: `nested-${index}`,
      },
    },
  })

describe('audit log integrity chain', () => {
  beforeEach(async () => {
    await clearAuditLogs()
  })

  afterAll(async () => {
    await clearAuditLogs()
    await closeDatabase()
  })

  it('verifies an intact organization chain', async () => {
    const first = await createOrgAuditLog(1)
    const second = await createOrgAuditLog(2)

    const result = await verifyAuditLogChain(organizationId)

    expect(result.verified).toBe(true)
    expect(result.checked_count).toBe(2)
    expect(result.failures).toEqual([])
    expect(first.prev_hash).toBe(AUDIT_LOG_GENESIS_HASH)
    expect(second.prev_hash).toBe(first.row_hash)
    expect(result.tail_hash).toBe(second.row_hash)
  })

  it('detects an altered audit row', async () => {
    const log = await createOrgAuditLog(1)
    await db('audit_logs').where({ id: log.id }).update({
      metadata: {
        safe_note: 'tampered',
      },
    })

    const result = await verifyAuditLogChain(organizationId)

    expect(result.verified).toBe(false)
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: log.id,
          reason: 'row_hash_mismatch',
        }),
      ]),
    )
  })

  it('detects a removed middle row', async () => {
    await createOrgAuditLog(1)
    const second = await createOrgAuditLog(2)
    const third = await createOrgAuditLog(3)

    await db('audit_logs').where({ id: second.id }).delete()

    const result = await verifyAuditLogChain(organizationId)

    expect(result.verified).toBe(false)
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: third.id,
          reason: 'prev_hash_mismatch',
        }),
      ]),
    )
  })

  it('exports only the requested organization with redacted PII and chain proof', async () => {
    const log = await createOrgAuditLog(1)
    await createAuditLog({
      actor_user_id: 'other-user',
      organization_id: '00000000-0000-4000-8000-000000000999',
      action: 'vault.updated',
      target_type: 'vault',
      target_id: 'other-vault',
      metadata: { safe_note: 'do-not-export' },
    })

    const rawMetadata = {
      safe_note: 'kept-1',
      contact: 'person-1@example.com',
      nested: {
        apiKey: 'a'.repeat(40),
        visible: 'nested-1',
      },
    }
    const rawRow = {
      ...log,
      metadata: rawMetadata,
    }
    await db('audit_logs')
      .where({ id: log.id })
      .update({
        metadata: rawMetadata,
        row_hash: hashAuditLogRow(log.prev_hash, rawRow),
      })

    const auditExport = await exportAuditLogsForOrganization(organizationId)
    const serialized = JSON.stringify(auditExport)

    expect(auditExport.organization_id).toBe(organizationId)
    expect(auditExport.audit_logs).toHaveLength(1)
    expect(auditExport.proof).toHaveLength(1)
    expect(auditExport.chain.verified).toBe(true)
    expect(serialized).not.toContain('person-1@example.com')
    expect(serialized).not.toContain('do-not-export')
    expect(serialized).not.toContain('a'.repeat(40))
    expect(auditExport.audit_logs[0].metadata.safe_note).toBe('kept-1')
  })
})
