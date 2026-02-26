import { Router, Request, Response } from 'express'
import { authenticate, authorize } from '../middleware/auth.middleware.js'
import { UserRole, UserStatus } from '../types/user.js'
import { userService } from '../services/user.service.js'
import { forceRevokeUserSessions } from '../services/session.js'
import { createAuditLog, getAuditLogById, listAuditLogs } from '../lib/audit-logs.js'
import { cancelVaultById } from '../services/vaultStore.js'

export const adminRouter = Router()

// Apply authentication to all admin routes
adminRouter.use(authenticate)
adminRouter.use(authorize([UserRole.ADMIN]))

/**
 * Force-logout a user (Admin only)
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

adminRouter.get('/audit-logs', (req, res) => {
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
  const auditLog = getAuditLogById(req.params.id)
  if (!auditLog) {
    res.status(404).json({ error: 'Audit log not found' })
    return
  }

  res.status(200).json(auditLog)
})

adminRouter.post('/overrides/vaults/:id/cancel', async (req, res) => {
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
    actor_user_id: req.user!.userId,
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

// User Management Endpoints

// GET /api/admin/users - List users with filters and pagination
adminRouter.get('/users', async (req, res) => {
  try {
    const filters = {
      role: getStringQuery(req.query.role) as UserRole | undefined,
      status: getStringQuery(req.query.status) as UserStatus | undefined,
      search: getStringQuery(req.query.search),
      limit: getStringQuery(req.query.limit) ? Number(getStringQuery(req.query.limit)) : undefined,
      offset: getStringQuery(req.query.offset) ? Number(getStringQuery(req.query.offset)) : undefined,
    }

    // Validate role and status values
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

// PATCH /api/admin/users/:id/role - Update user role
adminRouter.patch('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body

    if (!role || !Object.values(UserRole).includes(role)) {
      return res.status(400).json({ 
        error: 'Invalid role. Must be one of: USER, VERIFIER, ADMIN' 
      })
    }

    const targetUser = await userService.getUserById(req.params.id)
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (targetUser.role === role) {
      return res.status(400).json({ error: 'User already has this role' })
    }

    const updatedUser = await userService.updateUserRole(req.params.id, role)
    if (!updatedUser) {
      return res.status(500).json({ error: 'Failed to update user role' })
    }

    // Create audit log
    const auditLog = createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'user.role.update',
      target_type: 'user',
      target_id: req.params.id,
      metadata: {
        old_role: targetUser.role,
        new_role: role,
        admin_id: req.user!.userId,
      },
    })

    res.status(200).json({
      user: updatedUser,
      auditLogId: auditLog.id,
    })
  } catch (error) {
    console.error('Error updating user role:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/admin/users/:id/status - Update user status
adminRouter.patch('/users/:id/status', async (req, res) => {
  try {
    const { status } = req.body

    if (!status || !Object.values(UserStatus).includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Must be one of: ACTIVE, INACTIVE, SUSPENDED' 
      })
    }

    const targetUser = await userService.getUserById(req.params.id)
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    if (targetUser.status === status) {
      return res.status(400).json({ error: 'User already has this status' })
    }

    const updatedUser = await userService.updateUserStatus(req.params.id, status)
    if (!updatedUser) {
      return res.status(500).json({ error: 'Failed to update user status' })
    }

    // Create audit log
    const auditLog = createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'user.status.update',
      target_type: 'user',
      target_id: req.params.id,
      metadata: {
        old_status: targetUser.status,
        new_status: status,
        admin_id: req.user!.userId,
      },
    })

    res.status(200).json({
      user: updatedUser,
      auditLogId: auditLog.id,
    })
  } catch (error) {
    console.error('Error updating user status:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})
