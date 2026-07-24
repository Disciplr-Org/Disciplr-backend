import crypto from 'crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  listOrgMemberships,
  createMembership,
  removeMembership,
  changeRole,
  transferOwnership,
  LastAdminError,
  resendInvitation,
  revokeInvitation,
  InvitationAcceptedError,
  InvitationNotFoundError,
} from '../services/membership.js'
import type { OrgRole } from '../models/organizations.js'
import db from '../db/index.js'
import { buildNotificationProviderRegistry } from '../services/notifications/factory.js'

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison to prevent timing attacks on the token hash. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still run timingSafeEqual on same-length buffers to mask the length check
    crypto.timingSafeEqual(Buffer.from(a.padEnd(64, '0')), Buffer.from(a.padEnd(64, '0')))
    return false
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

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
      const updated = await changeRole(userId, orgId, role as OrgRole, req.user!.userId)

      res.status(200).json({
        orgId,
        userId,
        role: updated.role,
      })
    } catch (err) {
      if (err instanceof LastAdminError || (err instanceof Error && err.message.includes('owner'))) {
        return next(AppError.unprocessable(err instanceof Error ? err.message : 'Cannot process.'))
      }

      const message = err instanceof Error ? err.message : 'Failed to update role.'
      return next(AppError.notFound(message))
    }
  },
)

// ─── POST /api/organizations/:orgId/transfer-ownership ──────────────────────
// Transfer ownership of an organization to another member.
// Demotes current owner to admin.

orgMembersRouter.post(
  '/:orgId/transfer-ownership',
  authenticate,
  requireOrgAccess('owner'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId } = req.params
    const { newOwnerId } = req.body as { newOwnerId?: string }

    if (!newOwnerId) {
      return next(AppError.badRequest('newOwnerId is required.'))
    }

    try {
      await transferOwnership(orgId, req.user!.userId, newOwnerId)
      res.status(200).json({ message: 'Ownership transferred.', orgId, newOwnerId })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to transfer ownership.'
      return next(AppError.unprocessable(message))
    }
  },
)

// ─── POST /api/organizations/:orgId/invitations ───────────────────────────────
// Issue a one-time invitation token for an email address.
// Only owners and admins may invite.

orgMembersRouter.post(
  '/:orgId/invitations',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId } = req.params
    const { email } = req.body as { email?: string }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return next(AppError.badRequest('A valid email is required.'))
    }

    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)

    try {
      const [invitation] = await db('org_invitations')
        .insert({ org_id: orgId, email, token_hash: tokenHash, expires_at: expiresAt })
        .returning(['id', 'org_id', 'email', 'expires_at'])

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'org.invitation.created',
        target_type: 'org_invitation',
        target_id: invitation.id,
        metadata: { orgId, email },
      })

      // Notify the invitee
      const provider = buildNotificationProviderRegistry().console
      await provider.send(
        email,
        `You have been invited to join an organization`,
        `Use this token to accept: ${rawToken} (expires ${expiresAt.toISOString()})`,
      )

      res.status(201).json({
        id: invitation.id,
        orgId: invitation.org_id,
        email: invitation.email,
        expiresAt: invitation.expires_at,
        token: rawToken, // returned once — caller delivers this to the recipient
      })
    } catch (err) {
      return next(AppError.internal('Failed to create invitation.'))
    }
  },
)

// ─── POST /api/organizations/:orgId/invitations/:id/resend ───────────────────
// Issue a fresh one-time token for a pending invitation. Only owners/admins.

orgMembersRouter.post(
  '/:orgId/invitations/:id/resend',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId, id } = req.params
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = hashToken(rawToken)
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)

    try {
      const invitation = await resendInvitation(orgId, id, tokenHash, expiresAt)

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'org.invitation.resent',
        target_type: 'org_invitation',
        target_id: invitation.id,
        metadata: { orgId },
      })

      const provider = buildNotificationProviderRegistry().console
      await provider.send(
        invitation.email,
        `You have been invited to join an organization`,
        `Use this token to accept: ${rawToken} (expires ${expiresAt.toISOString()})`,
      )

      res.status(200).json({
        id: invitation.id,
        orgId: invitation.org_id,
        email: invitation.email,
        expiresAt: invitation.expires_at,
        token: rawToken,
      })
    } catch (err) {
      if (err instanceof InvitationAcceptedError) {
        return next(AppError.conflict('Accepted invitations cannot be resent.'))
      }
      if (err instanceof InvitationNotFoundError) {
        return next(AppError.notFound(err.message))
      }

      return next(AppError.internal('Failed to resend invitation.'))
    }
  },
)

// ─── DELETE /api/organizations/:orgId/invitations/:id ────────────────────────
// Revoke a pending invitation. Accepted invitations are immutable.

orgMembersRouter.delete(
  '/:orgId/invitations/:id',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId, id } = req.params

    try {
      const invitation = await revokeInvitation(orgId, id)

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'org.invitation.revoked',
        target_type: 'org_invitation',
        target_id: invitation.id,
        metadata: { orgId },
      })

      res.status(200).json({
        id: invitation.id,
        orgId: invitation.org_id,
        email: invitation.email,
        revokedAt: invitation.revoked_at,
      })
    } catch (err) {
      if (err instanceof InvitationAcceptedError) {
        return next(AppError.conflict('Accepted invitations cannot be revoked.'))
      }
      if (err instanceof InvitationNotFoundError) {
        return next(AppError.notFound(err.message))
      }

      return next(AppError.internal('Failed to revoke invitation.'))
    }
  },
)

// ─── POST /api/organizations/:orgId/invitations/accept ────────────────────────
// Accept an invitation by submitting the raw token and desired userId.
// Promotes the recipient to org member.

orgMembersRouter.post(
  '/:orgId/invitations/accept',
  async (req: Request, res: Response, next: NextFunction) => {
    const { orgId } = req.params
    const { token, userId, role } = req.body as { token?: string; userId?: string; role?: string }

    if (!token || !userId) {
      return next(AppError.badRequest('token and userId are required.'))
    }

    const incomingHash = hashToken(token)

    const invitation = await db('org_invitations')
      .where({ org_id: orgId, token_hash: incomingHash })
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .where('expires_at', '>', new Date())
      .first()

    if (!invitation || !safeEqual(invitation.token_hash, incomingHash)) {
      return next(AppError.badRequest('Invalid or expired invitation token.'))
    }

    const validRoles: OrgRole[] = ['owner', 'admin', 'member']
    const assignedRole: OrgRole = validRoles.includes(role as OrgRole) ? (role as OrgRole) : 'member'

    try {
      const membership = await createMembership({
        user_id: userId,
        organization_id: orgId,
        role: assignedRole,
      })

      await db('org_invitations').where({ id: invitation.id }).update({ accepted_at: new Date() })

      createAuditLog({
        actor_user_id: userId,
        action: 'org.invitation.accepted',
        target_type: 'org_invitation',
        target_id: invitation.id,
        metadata: { orgId, userId, role: assignedRole },
      })

      res.status(200).json({ orgId, userId, role: membership.role })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to accept invitation.'
      return next(AppError.conflict(message))
    }
  },
)
