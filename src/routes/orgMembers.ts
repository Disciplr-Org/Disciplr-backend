import { Router, type Request, type Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { createAuditLog } from '../lib/audit-logs.js'
import {
  getOrgMembers,
  addOrgMember,
  removeOrgMember,
  updateOrgMemberRole,
  LastAdminError,
  type OrgRole,
} from '../models/organizations.js'

export const orgMembersRouter = Router()

// ─── GET /api/organizations/:orgId/members ────────────────────────────────────
// Any member can list the org's membership roster.

orgMembersRouter.get(
  '/:orgId/members',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  (req: Request, res: Response) => {
    const members = getOrgMembers(req.params.orgId)
    res.json({ members })
  },
)

// ─── POST /api/organizations/:orgId/members ───────────────────────────────────
// Add a new member. Only owners and admins may invite.

orgMembersRouter.post(
  '/:orgId/members',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  (req: Request, res: Response) => {
    const { orgId } = req.params
    const { userId, role } = req.body as { userId?: string; role?: string }

    if (!userId) {
      res.status(400).json({ error: 'userId is required.' })
      return
    }

    const validRoles: OrgRole[] = ['owner', 'admin', 'member']
    const assignedRole: OrgRole = validRoles.includes(role as OrgRole)
      ? (role as OrgRole)
      : 'member'

    try {
      addOrgMember({ orgId, userId, role: assignedRole })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add member.'
      res.status(409).json({ error: message })
      return
    }

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'org.member.added',
      target_type: 'org_membership',
      target_id: `${orgId}:${userId}`,
      metadata: { orgId, role: assignedRole },
    })

    res.status(201).json({ orgId, userId, role: assignedRole })
  },
)

// ─── DELETE /api/organizations/:orgId/members/:userId ─────────────────────────
// Remove a member. Only owners and admins may remove. Blocked if last admin.

orgMembersRouter.delete(
  '/:orgId/members/:userId',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  (req: Request, res: Response) => {
    const { orgId, userId } = req.params

    try {
      removeOrgMember(orgId, userId)
    } catch (err) {
      if (err instanceof LastAdminError) {
        res.status(422).json({ error: err.message })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to remove member.'
      res.status(404).json({ error: message })
      return
    }

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'org.member.removed',
      target_type: 'org_membership',
      target_id: `${orgId}:${userId}`,
      metadata: { orgId },
    })

    res.status(200).json({ message: 'Member removed.', orgId, userId })
  },
)

// ─── PATCH /api/organizations/:orgId/members/:userId/role ─────────────────────
// Change a member's role. Only owners may do this. Blocked if last admin demotion.

orgMembersRouter.patch(
  '/:orgId/members/:userId/role',
  authenticate,
  requireOrgAccess('owner'),
  (req: Request, res: Response) => {
    const { orgId, userId } = req.params
    const { role } = req.body as { role?: string }

    const validRoles: OrgRole[] = ['owner', 'admin', 'member']
    if (!role || !validRoles.includes(role as OrgRole)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}.` })
      return
    }

    try {
      updateOrgMemberRole(orgId, userId, role as OrgRole)
    } catch (err) {
      if (err instanceof LastAdminError) {
        res.status(422).json({ error: err.message })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to update role.'
      res.status(404).json({ error: message })
      return
    }

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'org.member.role_changed',
      target_type: 'org_membership',
      target_id: `${orgId}:${userId}`,
      metadata: { orgId, newRole: role },
    })

    res.status(200).json({ orgId, userId, role })
  },
)
