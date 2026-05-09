import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  listOrgMemberships,
  createMembership,
  removeMembership,
  updateMemberRole,
  LastAdminError,
} from '../services/membership.js'
import type { OrgRole } from '../models/organizations.js'

export const orgMembersRouter = Router()

// ─── GET /api/organizations/:orgId/members ────────────────────────────────────
// Any member can list the org's membership roster.

orgMembersRouter.get(
  '/:orgId/members',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: Request, res: Response) => {
    try {
      const members = await listOrgMemberships(req.params.orgId)
      res.json({ members })
    } catch {
      res.status(500).json({ error: 'Failed to list members.' })
    }
  },
)

// ─── POST /api/organizations/:orgId/members ───────────────────────────────────
// Add a new member. Only owners and admins may invite.

orgMembersRouter.post(
  '/:orgId/members',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId } = req.params
    const { userId, role } = req.body as { userId?: string; role?: string }

    if (!userId) {
      return next(AppError.badRequest('userId is required.'))
    }

    const validRoles: OrgRole[] = ['owner', 'admin', 'member']
    const assignedRole: OrgRole = validRoles.includes(role as OrgRole)
      ? (role as OrgRole)
      : 'member'

    try {
      const membership = await createMembership({
        user_id: userId,
        organization_id: orgId,
        role: assignedRole,
      })

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'org.member.added',
        target_type: 'org_membership',
        target_id: `${orgId}:${userId}`,
        metadata: { orgId, role: assignedRole },
      })

      res.status(201).json({
        orgId,
        userId,
        role: membership.role,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add member.'
      return next(AppError.conflict(message))
    }
  },
)

// ─── DELETE /api/organizations/:orgId/members/:userId ─────────────────────────
// Remove a member. Only owners and admins may remove. Blocked if last admin.

orgMembersRouter.delete(
  '/:orgId/members/:userId',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId, userId } = req.params

    try {
      await removeMembership(userId, orgId)

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'org.member.removed',
        target_type: 'org_membership',
        target_id: `${orgId}:${userId}`,
        metadata: { orgId },
      })

      res.status(200).json({ message: 'Member removed.', orgId, userId })
    } catch (err) {
      if (err instanceof LastAdminError) {
        return next(AppError.unprocessable(err.message))
      }

      const message = err instanceof Error ? err.message : 'Failed to remove member.'
      return next(AppError.notFound(message))
    }
  },
)

// ─── PATCH /api/organizations/:orgId/members/:userId/role ─────────────────────
// Change a member's role. Only owners may do this. Blocked if last admin demotion.

orgMembersRouter.patch(
  '/:orgId/members/:userId/role',
  authenticate,
  requireOrgAccess('owner'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId, userId } = req.params
    const { role } = req.body as { role?: string }

    const validRoles: OrgRole[] = ['owner', 'admin', 'member']
    if (!role || !validRoles.includes(role as OrgRole)) {
      return next(AppError.validation(`role must be one of: ${validRoles.join(', ')}.`))
    }

    try {
      const updated = await updateMemberRole(userId, orgId, role as OrgRole)

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'org.member.role_changed',
        target_type: 'org_membership',
        target_id: `${orgId}:${userId}`,
        metadata: { orgId, newRole: role },
      })

      res.status(200).json({
        orgId,
        userId,
        role: updated.role,
      })
    } catch (err) {
      if (err instanceof LastAdminError) {
        return next(AppError.unprocessable(err.message))
      }

      const message = err instanceof Error ? err.message : 'Failed to update role.'
      return next(AppError.notFound(message))
    }
  },
)