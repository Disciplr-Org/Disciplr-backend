import type { Knex } from 'knex'
import db from '../db/index.js'
import { createAuditLog } from '../lib/audit-logs.js'
import type { Membership, CreateMembershipInput } from '../types/enterprise.js'

// ─── Error types ──────────────────────────────────────────────────────────────

export class LastAdminError extends Error {
  constructor() {
    super('Cannot remove or demote the last admin of an organization.')
    this.name = 'LastAdminError'
  }
}

export class InvitationNotFoundError extends Error {
  constructor() {
    super('Invitation not found.')
    this.name = 'InvitationNotFoundError'
  }
}

export class InvitationAcceptedError extends Error {
  constructor() {
    super('Accepted invitations cannot be modified.')
    this.name = 'InvitationAcceptedError'
  }
}

type OrgInvitation = {
  id: string
  org_id: string
  email: string
  token_hash: string
  expires_at: Date | string
  accepted_at: Date | string | null
  revoked_at?: Date | string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isAdminRole = (role: string): boolean =>
  role === 'owner' || role === 'admin'

/** Precedence for resolving conflicting org/team role grants (higher wins). */
export const ORG_ROLE_RANK: Readonly<Record<string, number>> = {
  owner: 3,
  admin: 2,
  member: 1,
  viewer: 0,
}

export const getOrgRoleRank = (role: string): number =>
  ORG_ROLE_RANK[role] ?? -1

export const isKnownOrgRole = (role: string): boolean =>
  role in ORG_ROLE_RANK

/** Pick the higher-precedence role between two grants. */
export const pickHigherOrgRole = (a: string, b: string): string =>
  getOrgRoleRank(a) >= getOrgRoleRank(b) ? a : b

/**
 * Resolve a user's effective org role from all org- and team-level memberships.
 * When multiple grants exist, the highest applicable role wins.
 */
export const resolveEffectiveOrgRole = async (
  userId: string,
  organizationId: string,
): Promise<string | null> => {
  const memberships = await db('memberships')
    .where({ user_id: userId, organization_id: organizationId })
    .select('role')

  if (memberships.length === 0) {
    return null
  }

  return memberships.reduce(
    (highest, membership) => pickHigherOrgRole(highest, membership.role),
    memberships[0].role,
  )
}

// ─── Create ───────────────────────────────────────────────────────────────────

export const createMembership = async (
  input: CreateMembershipInput,
): Promise<Membership> => {
  const [membership] = await db('memberships')
    .insert({
      user_id: input.user_id,
      organization_id: input.organization_id,
      team_id: input.team_id ?? null,
      role: input.role ?? 'member',
    })
    .returning('*')

  return membership
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export const listUserMemberships = async (
  userId: string,
): Promise<Membership[]> => {
  return db('memberships').where({ user_id: userId }).select('*')
}

export const listOrgMemberships = async (
  orgId: string,
): Promise<Membership[]> => {
  return db('memberships')
    .where({ organization_id: orgId, team_id: null })
    .select('*')
}

export const getUserOrganizationRole = async (
  userId: string,
  organizationId: string,
): Promise<string | null> => {
  const membership = await db('memberships')
    .where({
      user_id: userId,
      organization_id: organizationId,
      team_id: null,
    })
    .first()

  return membership ? membership.role : null
}

export const getUserTeamRole = async (
  userId: string,
  teamId: string,
): Promise<string | null> => {
  const membership = await db('memberships')
    .where({
      user_id: userId,
      team_id: teamId,
    })
    .first()

  return membership ? membership.role : null
}

// ─── Admin Count ──────────────────────────────────────────────────────────────

export const countOrgAdmins = async (
  orgId: string,
  queryBuilder: Knex | Knex.Transaction = db,
): Promise<number> => {
  // Aggregates can't be combined with a locking clause in Postgres, so the
  // matching rows are locked and counted in JS instead of via count(*).
  const rows = await queryBuilder('memberships')
    .where({ organization_id: orgId, team_id: null })
    .whereIn('role', ['owner', 'admin'])
    .forUpdate()
    .select('id')

  return rows.length
}

export const countOrgOwners = async (
  orgId: string,
  queryBuilder: Knex | Knex.Transaction = db,
): Promise<number> => {
  const rows = await queryBuilder('memberships')
    .where({ organization_id: orgId, team_id: null, role: 'owner' })
    .forUpdate()
    .select('id')

  return rows.length
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export const removeMembership = async (
  userId: string,
  orgId: string,
): Promise<void> => {
  await db.transaction(async (trx) => {
    const membership = await trx('memberships')
      .where({
        user_id: userId,
        organization_id: orgId,
        team_id: null,
      })
      .forUpdate()
      .first()

    if (!membership) {
      throw new Error('Membership not found.')
    }

    if (membership.role === 'owner') {
      const ownerCount = await countOrgOwners(orgId, trx)
      if (ownerCount <= 1) {
        throw new Error('Cannot remove the last owner of an organization.')
      }
    }

    if (isAdminRole(membership.role)) {
      const adminCount = await countOrgAdmins(orgId, trx)
      if (adminCount <= 1) {
        throw new LastAdminError()
      }
    }

    await trx('memberships')
      .where({
        user_id: userId,
        organization_id: orgId,
        team_id: null,
      })
      .delete()
  })
}

// ─── Update ───────────────────────────────────────────────────────────────────

export const changeRole = async (
  userId: string,
  orgId: string,
  newRole: string,
  actorUserId: string,
): Promise<Membership> => {
  return db.transaction(async (trx) => {
    const membership = await trx('memberships')
      .where({
        user_id: userId,
        organization_id: orgId,
        team_id: null,
      })
      .forUpdate()
      .first()

    if (!membership) {
      throw new Error('Membership not found.')
    }

    const oldRole = membership.role
    if (oldRole === newRole) {
      return membership
    }

    if (oldRole === 'owner') {
      const ownerCount = await countOrgOwners(orgId, trx)
      if (ownerCount <= 1) {
        throw new Error('Cannot demote the last owner of an organization.')
      }
    } else if (isAdminRole(oldRole) && !isAdminRole(newRole)) {
      const adminCount = await countOrgAdmins(orgId, trx)
      if (adminCount <= 1) {
        throw new LastAdminError()
      }
    }

    const [updated] = await trx('memberships')
      .where({
        user_id: userId,
        organization_id: orgId,
        team_id: null,
      })
      .update({ role: newRole })
      .returning('*')

    await createAuditLog({
      actor_user_id: actorUserId,
      organization_id: orgId,
      action: 'org.member.role_changed',
      target_type: 'org_membership',
      target_id: `${orgId}:${userId}`,
      metadata: { org_id: orgId, old_role: oldRole, new_role: newRole },
    })

    return updated
  })
}

// ─── Invitations ─────────────────────────────────────────────────────────────

const getOrgInvitation = async (
  orgId: string,
  invitationId: string,
): Promise<OrgInvitation> => {
  const invitation = await db('org_invitations')
    .where({ id: invitationId, org_id: orgId })
    .first()

  if (!invitation) {
    throw new InvitationNotFoundError()
  }

  return invitation
}

export const resendInvitation = async (
  orgId: string,
  invitationId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<OrgInvitation> => {
  const invitation = await getOrgInvitation(orgId, invitationId)

  if (invitation.accepted_at) {
    throw new InvitationAcceptedError()
  }

  const [updated] = await db('org_invitations')
    .where({ id: invitationId, org_id: orgId })
    .update({
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
    })
    .returning(['id', 'org_id', 'email', 'expires_at', 'accepted_at', 'revoked_at'])

  return updated
}

export const revokeInvitation = async (
  orgId: string,
  invitationId: string,
  revokedAt = new Date(),
): Promise<OrgInvitation> => {
  const invitation = await getOrgInvitation(orgId, invitationId)

  if (invitation.accepted_at) {
    throw new InvitationAcceptedError()
  }

  const [updated] = await db('org_invitations')
    .where({ id: invitationId, org_id: orgId })
    .update({ revoked_at: revokedAt })
    .returning(['id', 'org_id', 'email', 'expires_at', 'accepted_at', 'revoked_at'])

  return updated
}

export const transferOwnership = async (
  orgId: string,
  currentOwnerId: string,
  newOwnerId: string,
): Promise<void> => {
  await db.transaction(async (trx) => {
    const currentOwner = await trx('memberships')
      .where({ user_id: currentOwnerId, organization_id: orgId, team_id: null })
      .first()

    if (!currentOwner || currentOwner.role !== 'owner') {
      throw new Error('Caller is not an owner.')
    }

    const newOwner = await trx('memberships')
      .where({ user_id: newOwnerId, organization_id: orgId, team_id: null })
      .first()

    if (!newOwner) {
      throw new Error('Target user is not a member of the organization.')
    }

    if (newOwner.role !== 'owner') {
      await trx('memberships')
        .where({ user_id: newOwnerId, organization_id: orgId, team_id: null })
        .update({ role: 'owner' })
    }

    await trx('memberships')
      .where({ user_id: currentOwnerId, organization_id: orgId, team_id: null })
      .update({ role: 'admin' })

    await createAuditLog({
      actor_user_id: currentOwnerId,
      organization_id: orgId,
      action: 'org.ownership.transferred',
      target_type: 'org_membership',
      target_id: orgId,
      metadata: { org_id: orgId, from_user: currentOwnerId, to_user: newOwnerId },
    })
  })
}
