import { Router, Request, Response, NextFunction } from 'express'
import { requireAdmin } from '../middleware/rbac.js'
import { queryParser } from '../middleware/queryParser.js'
import { authenticate } from '../middleware/auth.js'
import { requireStepUp } from '../middleware/stepUp.js'
import { UserRole, UserStatus } from '../types/user.js'
import { userService, DeleteResult } from '../services/user.service.js'
import { forceRevokeUserSessions } from '../services/session.js'
import {
  createAuditLog,
  exportAuditLogsForOrganization,
  getAuditLogById,
  listAuditLogs,
  verifyAuditLogChain,
} from '../lib/audit-logs.js'
import { cancelVaultById } from '../services/vaultStore.js'
import { getDBHealthMetrics, getSlowQueryBuffer } from '../services/dbMetrics.js'
import {
  getFlag,
  setFlag,
  FeatureFlag,
  isValidFeatureFlag,
  getAllFlags,
} from '../services/featureFlags.js'
import { pool } from '../db/index.js'
import { db } from '../db/knex.js'
import { getAbuseCategoryCounts } from '../security/abuse-monitor.js'
import { metricsRateLimiter } from '../middleware/rateLimiter.js'
import { CheckpointStore } from '../services/checkpointStore.js'
import { getLatestListenerLag } from '../services/monitor.js'
import { generateImpersonationToken } from '../lib/auth-utils.js'
import { getPrisma } from '../lib/prismaScope.js'
import { recordSession } from '../services/session.js'
import { randomUUID } from 'node:crypto'
import {
  detectEmbeddingDrift,
  CURRENT_EMBEDDING_MODEL_VERSION,
  createEmbeddingProvider,
} from '../services/embeddingProvider.js'
import { runReindexBatches, EMBEDDING_REINDEX_JOB_NAME } from '../services/evidenceReindex.js'
import { MilestoneRepository } from '../repositories/milestoneRepository.js'
import { BackfillCursorStore } from '../services/backfillCursorStore.js'

export const adminRouter = Router()

// Valid override reason codes - ensures explicit, auditable reasons
const ValidOverrideReasonCodes = [
  'USER_REQUEST',
  'FRAUD_DETECTED',
  'SYSTEM_ERROR',
  'POLICY_VIOLATION',
  'EMERGENCY_ADMIN_ACTION',
  'COMPLIANCE_REQUIREMENT',
  'TESTING_CLEANUP',
] as const

type OverrideReasonCode = (typeof ValidOverrideReasonCodes)[number]

// Track processed overrides for idempotency (in production, use distributed cache like Redis)
const processedOverrides = new Map<string, { auditLogId: string; timestamp: string }>()

// Test helper - clear processed overrides for test isolation
export const clearProcessedOverrides = (): void => {
  processedOverrides.clear()
}

// Export valid reason codes for tests and documentation
export { ValidOverrideReasonCodes }

const isValidReasonCode = (reason: unknown): reason is OverrideReasonCode =>
  typeof reason === 'string' && ValidOverrideReasonCodes.includes(reason as OverrideReasonCode)

// Sanitize reason text to prevent PII/secrets leakage
const sanitizeReasonText = (reason: string): string => {
  // Remove potential secrets/PII patterns
  return reason
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/\b(?:\d{4}-?){3}\d{4}\b/g, '[REDACTED_CARD]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]')
    .replace(/\b[A-Za-z0-9]{32,}\b/g, '[REDACTED_TOKEN]')
    .substring(0, 500) // Limit length
}

const toIsoString = (value: Date | string | null | undefined): string | null => {
  if (!value) return null
  return new Date(value).toISOString()
}

const parseContractAddresses = (): string[] =>
  (process.env.CONTRACT_ADDRESS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0)

const isValidLedger = (value: unknown): value is number =>
  Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0

const isValidPagingToken = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 256)

const resolveTargetContractAddress = async (
  suppliedContractAddress: unknown,
  checkpointStore: CheckpointStore,
): Promise<{ contractAddress: string } | { error: string; status: number }> => {
  if (typeof suppliedContractAddress === 'string' && suppliedContractAddress.trim().length > 0) {
    return { contractAddress: suppliedContractAddress.trim() }
  }

  const configuredAddresses = parseContractAddresses()
  if (configuredAddresses.length === 1) {
    return { contractAddress: configuredAddresses[0] }
  }

  const checkpoints = await checkpointStore.getAllCheckpoints()
  if (checkpoints.length === 1) {
    return { contractAddress: checkpoints[0].contractAddress }
  }

  return {
    status: 400,
    error: 'contractAddress is required when multiple or no Horizon contracts are configured',
  }
}

// Apply authentication to all admin routes
adminRouter.use(authenticate)
adminRouter.use(requireAdmin)

/**
 * GET /api/admin/horizon/listener
 * Detailed Horizon listener status for operators.
 */
adminRouter.get('/horizon/listener', async (_req: Request, res: Response) => {
  try {
    const checkpointStore = new CheckpointStore(db)
    const [checkpoints, state, lastFailedEvent, maxProcessedRow] = await Promise.all([
      checkpointStore.getAllCheckpoints(),
      db('listener_state')
        .where({ service_name: 'horizon_listener' })
        .select('last_processed_ledger', 'last_processed_at', 'updated_at')
        .first(),
      db('failed_events')
        .select('event_id', 'error_message', 'failed_at', 'retry_count')
        .orderBy('failed_at', 'desc')
        .first(),
      db('processed_events')
        .max('ledger_number as max_ledger')
        .first(),
    ])

    const now = Date.now()
    const lastProcessedAt = state?.last_processed_at ? new Date(state.last_processed_at) : null
    const lastProcessedLedger = state?.last_processed_ledger != null ? Number(state.last_processed_ledger) : null
    const cursorLedger = checkpoints.length > 0 ? Math.min(...checkpoints.map((checkpoint) => checkpoint.lastLedger)) : null
    const latestProcessedLedger =
      maxProcessedRow?.max_ledger != null ? Number(maxProcessedRow.max_ledger) : null

    res.status(200).json({
      data: {
        cursor: {
          effectiveLedger: cursorLedger,
          checkpoints: checkpoints.map((checkpoint) => ({
            contractAddress: checkpoint.contractAddress,
            lastLedger: checkpoint.lastLedger,
            lastPagingToken: checkpoint.lastPagingToken,
            updatedAt: checkpoint.updatedAt.toISOString(),
            createdAt: checkpoint.createdAt.toISOString(),
          })),
        },
        lastProcessedLedger,
        latestProcessedLedger,
        lag: getLatestListenerLag() ?? null,
        heartbeatAgeMs: lastProcessedAt ? now - lastProcessedAt.getTime() : null,
        lastProcessedAt: lastProcessedAt ? lastProcessedAt.toISOString() : null,
        listenerStateUpdatedAt: toIsoString(state?.updated_at),
        lastError: lastFailedEvent
          ? {
              eventId: lastFailedEvent.event_id,
              message: lastFailedEvent.error_message,
              retryCount: Number(lastFailedEvent.retry_count),
              failedAt: toIsoString(lastFailedEvent.failed_at),
            }
          : null,
      },
    })
  } catch (error) {
    console.error('Error fetching Horizon listener status:', error)
    res.status(500).json({ error: 'Failed to fetch Horizon listener status' })
  }
})

/**
 * POST /api/admin/horizon/listener/reset-cursor
 * Safely resets the resumable cursor for a Horizon contract.
 */
adminRouter.post('/horizon/listener/reset-cursor', async (req: Request, res: Response) => {
  try {
    const { contractAddress, ledger, pagingToken, force = false, reason } = req.body ?? {}

    if (!isValidLedger(ledger)) {
      res.status(400).json({ error: 'ledger must be a non-negative safe integer' })
      return
    }

    if (!isValidPagingToken(pagingToken)) {
      res.status(400).json({ error: 'pagingToken must be a non-empty string up to 256 characters' })
      return
    }

    if (typeof force !== 'boolean') {
      res.status(400).json({ error: 'force must be a boolean when supplied' })
      return
    }

    const checkpointStore = new CheckpointStore(db)
    const target = await resolveTargetContractAddress(contractAddress, checkpointStore)
    if ('error' in target) {
      res.status(target.status).json({ error: target.error })
      return
    }

    const [currentCheckpoint, maxProcessedRow] = await Promise.all([
      checkpointStore.getCheckpoint(target.contractAddress),
      db('processed_events')
        .max('ledger_number as max_ledger')
        .first(),
    ])

    const latestProcessedLedger =
      maxProcessedRow?.max_ledger != null ? Number(maxProcessedRow.max_ledger) : null

    if (!force && latestProcessedLedger !== null && ledger < latestProcessedLedger) {
      res.status(409).json({
        error: 'Refusing to move cursor behind already-processed events without force=true',
        latestProcessedLedger,
        requestedLedger: ledger,
      })
      return
    }

    const sanitizedReason = reason ? sanitizeReasonText(String(reason)) : undefined
    const normalizedPagingToken = pagingToken === undefined ? null : pagingToken

    await checkpointStore.resetCheckpoint(target.contractAddress, ledger, normalizedPagingToken)
    const updatedCheckpoint = await checkpointStore.getCheckpoint(target.contractAddress)

    const auditLog = await createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'horizon.listener.cursor_reset',
      target_type: 'horizon_listener',
      target_id: target.contractAddress,
      metadata: {
        contract_address: target.contractAddress,
        previous_ledger: currentCheckpoint?.lastLedger ?? null,
        previous_paging_token: currentCheckpoint?.lastPagingToken ?? null,
        requested_ledger: ledger,
        requested_paging_token: normalizedPagingToken,
        latest_processed_ledger: latestProcessedLedger,
        force,
        reason: sanitizedReason,
        request_context: {
          user_agent: req.headers['user-agent'],
          method: req.method,
          path: req.originalUrl,
        },
      },
    })

    res.status(200).json({
      message: 'Horizon listener cursor reset',
      checkpoint: updatedCheckpoint
        ? {
            contractAddress: updatedCheckpoint.contractAddress,
            lastLedger: updatedCheckpoint.lastLedger,
            lastPagingToken: updatedCheckpoint.lastPagingToken,
            updatedAt: updatedCheckpoint.updatedAt.toISOString(),
            createdAt: updatedCheckpoint.createdAt.toISOString(),
          }
        : null,
      previousCheckpoint: currentCheckpoint
        ? {
            contractAddress: currentCheckpoint.contractAddress,
            lastLedger: currentCheckpoint.lastLedger,
            lastPagingToken: currentCheckpoint.lastPagingToken,
            updatedAt: currentCheckpoint.updatedAt.toISOString(),
            createdAt: currentCheckpoint.createdAt.toISOString(),
          }
        : null,
      latestProcessedLedger,
      forced: force,
      auditLogId: auditLog.id,
    })
  } catch (error) {
    console.error('Error resetting Horizon listener cursor:', error)
    res.status(500).json({ error: 'Failed to reset Horizon listener cursor' })
  }
})

/**
 * Force-logout a user (Admin only) - Preserve Issue #46 logic
 * Force-logout a user (Admin only) - Issue #46 logic preserved
 */
adminRouter.post('/users/:userId/revoke-sessions', requireStepUp(), async (req: Request, res: Response) => {
  const { userId } = req.params
  
  if (!userId) {
    res.status(400).json({ error: 'Missing userId' })
    return
  }

  await forceRevokeUserSessions(userId)
  res.json({ message: `All sessions for user ${userId} have been revoked` })
})

const getStringQuery = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

adminRouter.get(
  '/audit-logs',
  // Validate sorting and filter fields to avoid arbitrary ORDER BY usage
  queryParser({
    allowedSortFields: ['created_at'],
    allowedFilterFields: ['organization_id', 'actor_user_id', 'action', 'target_type', 'target_id'],
  }),
  async (req, res) => {
    try {
      const limit = getStringQuery(req.query.limit) ? Number(getStringQuery(req.query.limit)) : undefined
      const offset = getStringQuery(req.query.offset) ? Number(getStringQuery(req.query.offset)) : undefined

      const logs = await listAuditLogs({
        organization_id: (req.filters as any)?.organization_id,
        actor_user_id: (req.filters as any)?.actor_user_id,
        action: (req.filters as any)?.action,
        target_type: (req.filters as any)?.target_type,
        target_id: (req.filters as any)?.target_id,
        limit,
        offset,
      })

    // Get total count for pagination metadata
    let countQuery = db('audit_logs').count('* as total')
    
    if (req.query.actor_user_id) {
      countQuery = countQuery.where('actor_user_id', getStringQuery(req.query.actor_user_id))
    }
    if (req.query.action) {
      countQuery = countQuery.where('action', getStringQuery(req.query.action))
    }
    if (req.query.target_type) {
      countQuery = countQuery.where('target_type', getStringQuery(req.query.target_type))
    }
    if (req.query.target_id) {
      countQuery = countQuery.where('target_id', getStringQuery(req.query.target_id))
    }
    // Include organization filter when provided via validated queryParser filters
    if ((req.filters as any)?.organization_id) {
      countQuery = countQuery.where('organization_id', (req.filters as any).organization_id)
    }
    
    const [{ total }] = await countQuery
    const totalCount = parseInt(total as string)
    const currentOffset = offset || 0

    res.status(200).json({
      audit_logs: logs,
      count: logs.length,
      total: totalCount,
      limit,
      offset: currentOffset,
      has_more: currentOffset + logs.length < totalCount,
    })
  } catch (error) {
    console.error('Error fetching audit logs:', error)
    res.status(500).json({ error: 'Failed to fetch audit logs' })
  }
})

adminRouter.get('/audit-logs/organizations/:organizationId/export', async (req, res) => {
  try {
    const { organizationId } = req.params
    const auditExport = await exportAuditLogsForOrganization(organizationId)

    res.status(200).json(auditExport)
  } catch (error) {
    console.error('Error exporting organization audit logs:', error)
    res.status(500).json({ error: 'Failed to export audit logs' })
  }
})

adminRouter.get('/audit-logs/organizations/:organizationId/verify', async (req, res) => {
  try {
    const result = await verifyAuditLogChain(req.params.organizationId)
    res.status(result.verified ? 200 : 409).json(result)
  } catch (error) {
    console.error('Error verifying organization audit log chain:', error)
    res.status(500).json({ error: 'Failed to verify audit log chain' })
  }
})

adminRouter.post('/audit-logs/verify', async (req, res) => {
  try {
    const organizationId = typeof req.body?.organization_id === 'string' ? req.body.organization_id : null
    const result = await verifyAuditLogChain(organizationId)
    res.status(result.verified ? 200 : 409).json(result)
  } catch (error) {
    console.error('Error verifying audit log chain:', error)
    res.status(500).json({ error: 'Failed to verify audit log chain' })
  }
})

adminRouter.get('/audit-logs/:id', async (req, res) => {
  try {
    const auditLog = await getAuditLogById(req.params.id)
    if (!auditLog) {
      res.status(404).json({ error: 'Audit log not found' })
      return
    }

    res.status(200).json(auditLog)
  } catch (error) {
    console.error('Error fetching audit log by ID:', error)
    res.status(500).json({ error: 'Failed to fetch audit log' })
  }
})

adminRouter.post('/overrides/vaults/:id/cancel', requireStepUp(), async (req, res) => {
  const { id } = req.params
  const { reason, reasonCode, idempotencyKey, details } = req.body ?? {}

  // 1. Validate reason code is provided and valid
  if (!reasonCode) {
    res.status(400).json({
      error: 'Missing required field: reasonCode',
      validReasonCodes: ValidOverrideReasonCodes,
    })
    return
  }

  if (!isValidReasonCode(reasonCode)) {
    res.status(400).json({
      error: `Invalid reasonCode. Must be one of: ${ValidOverrideReasonCodes.join(', ')}`,
      validReasonCodes: ValidOverrideReasonCodes,
    })
    return
  }

  // 2. Check idempotency - prevent repeated overrides
  const effectiveIdempotencyKey = idempotencyKey ?? `${req.user!.userId}:${id}:cancel`
  const existingOverride = processedOverrides.get(effectiveIdempotencyKey)
  if (existingOverride) {
    res.status(409).json({
      error: 'Override already processed - idempotent replay',
      idempotencyKey: effectiveIdempotencyKey,
      auditLogId: existingOverride.auditLogId,
      processedAt: existingOverride.timestamp,
    })
    return
  }

  // 3. Get current vault state before attempting cancel
  const cancelResult = await cancelVaultById(id)
  if ('error' in cancelResult) {
    if (cancelResult.error === 'already_cancelled') {
      // Record this for idempotency tracking even though no change occurred
      const auditLog = await createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'admin.override',
        target_type: 'vault',
        target_id: id,
        metadata: {
          override_type: 'vault.cancel',
          result: 'no_op_already_cancelled',
          previous_status: 'cancelled',
          new_status: 'cancelled',
          reason_code: reasonCode,
          reason_text: reason ? sanitizeReasonText(String(reason)) : undefined,
          idempotency_key: effectiveIdempotencyKey,
        },
      })
      processedOverrides.set(effectiveIdempotencyKey, {
        auditLogId: auditLog.id,
        timestamp: auditLog.created_at,
      })

      res.status(409).json({
        error: 'Vault is already cancelled',
        auditLogId: auditLog.id,
      })
      return
    }
    if (cancelResult.error === 'not_cancellable') {
      res.status(409).json({
        error: `Vault cannot be cancelled from status: ${cancelResult.currentStatus}`,
        currentStatus: cancelResult.currentStatus,
      })
      return
    }
    res.status(404).json({ error: 'Vault not found' })
    return
  }

  // 4. Sanitize optional details text
  const sanitizedDetails = details ? sanitizeReasonText(String(details)) : undefined
  const sanitizedReason = reason ? sanitizeReasonText(String(reason)) : undefined

  // 5. Create rich audit log with before/after diffs and request context
  const auditLog = await createAuditLog({
    actor_user_id: req.user!.userId,
    action: 'admin.override',
    target_type: 'vault',
    target_id: cancelResult.vault.id,
    metadata: {
      override_type: 'vault.cancel',
      previous_status: cancelResult.previousStatus,
      new_status: cancelResult.vault.status,
      reason_code: reasonCode,
      reason_text: sanitizedReason,
      details: sanitizedDetails,
      idempotency_key: effectiveIdempotencyKey,
      request_context: {
        user_agent: req.headers['user-agent'],
        method: req.method,
        path: req.originalUrl,
      },
      diff: {
        status: {
          before: cancelResult.previousStatus,
          after: cancelResult.vault.status,
        },
        changed_at: new Date().toISOString(),
      },
    },
  })

  // 6. Record for idempotency
  processedOverrides.set(effectiveIdempotencyKey, {
    auditLogId: auditLog.id,
    timestamp: auditLog.created_at,
  })

  res.status(200).json({
    vault: cancelResult.vault,
    auditLogId: auditLog.id,
    idempotencyKey: effectiveIdempotencyKey,
    previousStatus: cancelResult.previousStatus,
    newStatus: cancelResult.vault.status,
  })
})

// User Management Endpoints
adminRouter.get('/users', async (req, res) => {
  try {
    const filters = {
      role: getStringQuery(req.query.role) as UserRole | undefined,
      status: getStringQuery(req.query.status) as UserStatus | undefined,
      search: getStringQuery(req.query.search),
      limit: getStringQuery(req.query.limit) ? Number(getStringQuery(req.query.limit)) : undefined,
      offset: getStringQuery(req.query.offset) ? Number(getStringQuery(req.query.offset)) : undefined,
      includeDeleted: req.query.includeDeleted === 'true',
    }

    if (filters.role && !Object.values(UserRole).includes(filters.role)) {
      return res.status(400).json({ error: 'Invalid role value' })
    }
    if (filters.status && !Object.values(UserStatus).includes(filters.status)) {
      return res.status(400).json({ error: 'Invalid status value' })
    }

    const result = await userService.listUsers(filters)
    res.status(200).json(result)
  } catch (error) {
    console.error('Error listing users:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

adminRouter.patch('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body
    if (!role || !Object.values(UserRole).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' })
    }
    const targetUser = await userService.getUserById(req.params.id)
    if (!targetUser) return res.status(404).json({ error: 'User not found' })

    const updatedUser = await userService.updateUserRole(req.params.id, role)
    await createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'user.role.update',
      target_type: 'user',
      target_id: req.params.id,
      metadata: { old_role: targetUser.role, new_role: role },
    })
    res.status(200).json({ user: updatedUser })
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

adminRouter.patch('/users/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    if (!status || !Object.values(UserStatus).includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const targetUser = await userService.getUserById(req.params.id)
    if (!targetUser) return res.status(404).json({ error: 'User not found' })

    const updatedUser = await userService.updateUserStatus(req.params.id, status)
    await createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'user.status.update',
      target_type: 'user',
      target_id: req.params.id,
      metadata: { old_status: targetUser.status, new_status: status },
    })
    res.status(200).json({ user: updatedUser })
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

adminRouter.delete('/users/:id', async (req, res) => {
  try {
    const hard = req.query.hard === 'true'
    const targetUser = await userService.getUserById(req.params.id, true)

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (req.params.id === req.user!.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' })
    }

    let result: DeleteResult | null

    if (hard) {
      result = await userService.hardDeleteUser(req.params.id)
    } else {
      result = await userService.softDeleteUser(req.params.id)
    }

    if (!result) {
      return res.status(500).json({ error: 'Failed to delete user' })
    }

    if (!result.success && result.deletionType === 'soft') {
      return res.status(409).json({
        error: 'User is already deleted',
        deletedAt: result.deletedAt
      })
    }

    const auditLog = await createAuditLog({
      actor_user_id: req.user!.userId,
      action: hard ? 'user.hard_delete' : 'user.soft_delete',
      target_type: 'user',
      target_id: req.params.id,
      metadata: {
        deletion_type: result.deletionType,
        deleted_at: result.deletedAt,
        target_email: targetUser.email
      },
    })

    res.status(200).json({
      message: hard ? 'User permanently deleted' : 'User soft-deleted',
      result,
      auditLogId: auditLog.id
    })
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

adminRouter.post('/users/:id/restore', async (req, res) => {
  try {
    const targetUser = await userService.getUserById(req.params.id, true)

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (!targetUser.deletedAt) {
      return res.status(400).json({ error: 'User is not deleted' })
    }

    const restoredUser = await userService.restoreUser(req.params.id)

    if (!restoredUser) {
      return res.status(500).json({ error: 'Failed to restore user' })
    }

    const auditLog = await createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'user.restore',
      target_type: 'user',
      target_id: req.params.id,
      metadata: {
        previous_deleted_at: targetUser.deletedAt,
        target_email: targetUser.email
      },
    })

    res.status(200).json({
      message: 'User restored',
      user: restoredUser,
      auditLogId: auditLog.id
    })
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Get database pool health metrics and slow query samples (Admin only)
 * GET /api/admin/db/metrics
 * Rate limited to 20 req/min for security and performance
 */
adminRouter.get('/db/metrics', metricsRateLimiter, async (req: Request, res: Response) => {
  try {
    // Validate pool is available
    if (!pool) {
      res.status(503).json({
        error: 'Database pool unavailable',
        status: 'unavailable',
      })
      return
    }

    const metrics = getDBHealthMetrics(pool)

    // Log metrics access for audit trail
    await createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'admin.metrics.access',
      target_type: 'database',
      target_id: 'pool',
      metadata: {
        isHealthy: metrics.isHealthy,
        warningsCount: metrics.warnings.length,
        slowQueriesCount: metrics.slowQueries.length,
      },
    })

    res.status(200).json({
      data: {
        timestamp: metrics.pool.timestamp,
        isHealthy: metrics.isHealthy,
        pool: {
          available: metrics.pool.availableConnections,
          waiting: metrics.pool.waitingClients,
          total: metrics.pool.totalConnections,
          capacity: metrics.pool.poolSize,
        },
        slowQueries: metrics.slowQueries.map((query) => ({
          hash: query.queryHash,
          pattern: query.queryPattern,
          maxDurationMs: query.duration,
          occurrences: query.count,
          lastOccurred: query.lastOccurred,
        })),
        warnings: metrics.warnings,
      },
    })
  } catch (error) {
    console.error('Error retrieving DB metrics:', error)
    res.status(500).json({ error: 'Failed to retrieve database metrics' })
  }
})

/**
 * GET /api/admin/db/slow-queries
 * Returns the ring-buffered slow-query samples (admin only).
 * Entries are ordered oldest → newest; fingerprints only, no raw parameters.
 */
adminRouter.get('/db/slow-queries', (req: Request, res: Response) => {
  const entries = getSlowQueryBuffer()
  res.status(200).json({
    data: {
      count: entries.length,
      thresholdMs: (() => { const v = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '200', 10); return Math.max(0, isNaN(v) ? 200 : v) })(),
      bufferSize: (() => { const v = parseInt(process.env.SLOW_QUERY_BUFFER_SIZE ?? '100', 10); return Math.max(1, isNaN(v) ? 100 : v) })(),
      entries,
    },
  })
})

/**
 * GET /api/admin/abuse/category-counts
 * Returns per-category abuse event counts (brute-force, enumeration, payload-anomaly, rate-limit-trip).
 * Admin only.
 */
adminRouter.get('/abuse/category-counts', (req: Request, res: Response) => {
  res.status(200).json({ data: getAbuseCategoryCounts() })
})

// Admin impersonation endpoint - issues a short-lived token impersonating another user
adminRouter.post('/impersonate/:userId', requireStepUp(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const targetUserId = req.params.userId
    const targetUser = await getPrisma().user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true }
    })

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    const jti = randomUUID()
    const expiresIn = process.env.JWT_IMPERSONATION_EXPIRES_IN || '15m'
    let expiresAtMs: number
    if (expiresIn.endsWith('m')) {
      expiresAtMs = parseInt(expiresIn.slice(0, -1)) * 60 * 1000
    } else if (expiresIn.endsWith('h')) {
      expiresAtMs = parseInt(expiresIn.slice(0, -1)) * 60 * 60 * 1000
    } else if (expiresIn.endsWith('s')) {
      expiresAtMs = parseInt(expiresIn.slice(0, -1)) * 1000
    } else if (expiresIn.endsWith('d')) {
      expiresAtMs = parseInt(expiresIn.slice(0, -1)) * 24 * 60 * 60 * 1000
    } else {
      expiresAtMs = 15 * 60 * 1000 // default 15 minutes
    }

    const expiresAt = new Date(Date.now() + expiresAtMs)
    await recordSession(targetUserId, jti, expiresAt)

    const impersonationToken = generateImpersonationToken(
      req.user.userId,
      targetUserId,
      targetUser.role
    )

    // Audit log - impersonation started
    await createAuditLog({
      actor_user_id: req.user.userId,
      action: 'impersonation.start',
      target_type: 'user',
      target_id: targetUserId,
      metadata: {
        impersonator: req.user.userId,
        impersonated_user: targetUserId,
        token_expires_at: expiresAt.toISOString()
      }
    })

    res.status(200).json({
      accessToken: impersonationToken,
      expiresAt: expiresAt.toISOString(),
      userId: targetUserId,
      role: targetUser.role
    })
  } catch (error: any) {
    next(error)
  }
})

// ── Embedding drift ───────────────────────────────────────────────────────────

/**
 * GET /api/admin/embeddings/drift
 *
 * Returns a breakdown of stored embeddings grouped by model_version,
 * indicating how many are stale vs current.
 */
adminRouter.get('/embeddings/drift', async (req: Request, res: Response) => {
  try {
    const report = await detectEmbeddingDrift(db)

    await createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'admin.embeddings.drift.read',
      target_type: 'embedding_drift_report',
      target_id: report.currentModelVersion,
      metadata: { staleCount: report.staleCount, totalEmbeddings: report.totalEmbeddings },
    })

    res.status(200).json(report)
  } catch (error) {
    console.error('Error fetching embedding drift report:', error)
    res.status(500).json({ error: 'Failed to fetch embedding drift report' })
  }
})

/**
 * POST /api/admin/embeddings/reembed
 *
 * Enqueues an incremental re-embed run for stale milestone embeddings.
 * Resumable: uses the backfill cursor store so a second call continues
 * from where the previous run stopped.
 *
 * Optional body: { reset_cursor?: boolean, max_batches?: number }
 */
adminRouter.post('/embeddings/reembed', async (req: Request, res: Response) => {
  try {
    const { reset_cursor = false, max_batches } = req.body ?? {}

    const milestoneRepo = new MilestoneRepository(db)
    const cursorStore = new BackfillCursorStore(db)

    if (reset_cursor === true) {
      await cursorStore.resetCursor(EMBEDDING_REINDEX_JOB_NAME)
    }

    const provider = createEmbeddingProvider()

    const result = await runReindexBatches({
      source: milestoneRepo,
      cursorStore,
      embeddingProvider: provider,
      ...(typeof max_batches === 'number' && max_batches > 0 ? { maxBatchesPerRun: max_batches } : {}),
    })

    await createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'admin.embeddings.reembed.triggered',
      target_type: 'embedding_reindex',
      target_id: CURRENT_EMBEDDING_MODEL_VERSION,
      metadata: {
        batches: result.batches,
        reindexed: result.reindexed,
        skippedUpToDate: result.skippedUpToDate,
        done: result.done,
        cursor: result.cursor,
        resetCursor: reset_cursor,
      },
    })

    res.status(202).json(result)
  } catch (error) {
    console.error('Error triggering embedding re-embed:', error)
    res.status(500).json({ error: 'Failed to trigger re-embed' })
  }
})
