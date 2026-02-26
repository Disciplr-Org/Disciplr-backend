import { Router, Request, Response } from 'express'
import { authenticate, requireAdmin as requireAdminMiddleware } from '../middleware/auth.js'
import { forceRevokeUserSessions } from '../services/session.js'
import { createAuditLog, getAuditLogById, listAuditLogs } from '../lib/audit-logs.js'
import { cancelVaultById } from '../services/vaultStore.js'

export const adminRouter = Router()

/**
 * Force-logout a user (Admin only)
 */
adminRouter.post('/users/:userId/revoke-sessions', authenticate, requireAdminMiddleware, async (req: Request, res: Response) => {
  const { userId } = req.params
  
  if (!userId) {
    res.status(400).json({ error: 'Missing userId' })
    return
  }

  await forceRevokeUserSessions(userId)
  res.json({ message: `All sessions for user ${userId} have been revoked` })
})

// Upstream admin routes
const getStringQuery = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const requireAdminHeader = (role: string | undefined, actorId: string | undefined): string | null => {
  if (role !== 'admin') {
    return null
  }

  if (!actorId) {
    return null
  }

  return actorId
}

adminRouter.get('/audit-logs', (req, res) => {
  const actorUserId = requireAdminHeader(req.header('x-user-role') ?? undefined, req.header('x-user-id') ?? undefined)
  if (!actorUserId) {
    res.status(403).json({ error: 'Admin access required (x-user-role=admin and x-user-id)' })
    return
  }

  const logs = listAuditLogs({
    actor_user_id: getStringQuery(req.query.actor_user_id),
    action: getStringQuery(req.query.action),
    target_type: getStringQuery(req.query.target_type),
    target_id: getStringQuery(req.query.target_id),
    limit: getStringQuery(req.query.limit) ? Number(getStringQuery(req.query.limit)) : undefined,
  })

  res.status(200).json({
    audit_logs: logs,
    count: logs.length,
  })
})

adminRouter.get('/audit-logs/:id', (req, res) => {
  const actorUserId = requireAdminHeader(req.header('x-user-role') ?? undefined, req.header('x-user-id') ?? undefined)
  if (!actorUserId) {
    res.status(403).json({ error: 'Admin access required (x-user-role=admin and x-user-id)' })
    return
  }

  const auditLog = getAuditLogById(req.params.id)
  if (!auditLog) {
    res.status(404).json({ error: 'Audit log not found' })
    return
  }

  res.status(200).json(auditLog)
})

adminRouter.post('/overrides/vaults/:id/cancel', async (req, res) => {
  const actorUserId = requireAdminHeader(req.header('x-user-role') ?? undefined, req.header('x-user-id') ?? undefined)
  if (!actorUserId) {
    res.status(403).json({ error: 'Admin access required (x-user-role=admin and x-user-id)' })
    return
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'No reason provided'

  const cancelResult = await cancelVaultById(req.params.id)
  if ('error' in cancelResult) {
    if (cancelResult.error === 'already_cancelled') {
      res.status(409).json({ error: 'Vault is already cancelled' })
      return
    }

    if (cancelResult.error === 'not_cancellable') {
      res.status(409).json({
        error: `Vault cannot be cancelled from status: ${cancelResult.currentStatus}`,
      })
      return
    }

    res.status(404).json({ error: 'Vault not found' })
    return
  }

  const auditLog = createAuditLog({
    actor_user_id: actorUserId,
    action: 'admin.override',
    target_type: 'vault',
    target_id: cancelResult.vault.id,
    metadata: {
      overrideType: 'vault.cancel',
      previousStatus: cancelResult.previousStatus,
      newStatus: cancelResult.vault.status,
      reason,
    },
  })

  res.status(200).json({
    vault: cancelResult.vault,
    auditLogId: auditLog.id,
  })
})
