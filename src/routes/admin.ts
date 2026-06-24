import { Router, Request, Response } from 'express'
import { requireAdmin } from '../middleware/rbac.js'
import { queryParser } from '../middleware/queryParser.js'
import { authenticate } from '../middleware/auth.js'
import { metricsRateLimiter } from '../middleware/rateLimiter.js'
import { UserRole, UserStatus } from '../types/user.js'
import { userService, DeleteResult } from '../services/user.service.js'
import { forceRevokeUserSessions } from '../services/session.js'
import { createAuditLog, getAuditLogById, listAuditLogs } from '../lib/audit-logs.js'
import { cancelVaultById } from '../services/vaultStore.js'
import { getDBHealthMetrics } from '../services/dbMetrics.js'
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

// Apply authentication to all admin routes
adminRouter.use(authenticate)
adminRouter.use(requireAdmin)

/**
 * Force-logout a user (Admin only) - Preserve Issue #46 logic
 * Force-logout a user (Admin only) - Issue #46 logic preserved
 */
adminRouter.post('/users/:userId/revoke-sessions', async (req: Request, res: Response) => {
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

adminRouter.post('/overrides/vaults/:id/cancel', async (req, res) => {
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
 * GET /api/admin/abuse/category-counts
 * Returns per-category abuse event counts (brute-force, enumeration, payload-anomaly, rate-limit-trip).
 * Admin only.
 */
adminRouter.get('/abuse/category-counts', (req: Request, res: Response) => {
  res.status(200).json({ data: getAbuseCategoryCounts() })
})
