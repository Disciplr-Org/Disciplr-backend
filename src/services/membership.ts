import { db } from '../db/index.js'
import type { Membership, CreateMembershipInput } from '../types/enterprise.js'

// ─── Error types ──────────────────────────────────────────────────────────────

/**
 * Thrown when an operation would leave an organization with no admin-level
 * members ('owner' or 'admin' role).
 */
export class LastAdminError extends Error {
  constructor() {
    super('Cannot remove or demote the last admin of an organization.')
    this.name = 'LastAdminError'
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const isAdminRole = (role: string): boolean => role === 'owner' || role === 'admin'

// ─── Read operations ──────────────────────────────────────────────────────────

export const createMembership = async (input: CreateMembershipInput): Promise<Membership> => {
  const [membership] = await db('memberships')
    .insert({
      user_id: input.user_id,
      organization_id: input.organization_id,
      team_id: input.team_id || null,
      role: input.role || 'member',
    })
    .returning('*')
  return membership
}

export const listUserMemberships = async (userId: string): Promise<Membership[]> => {
  return db('memberships').where({ user_id: userId }).select('*')
}

export const listOrgMemberships = async (orgId: string): Promise<Membership[]> => {
  return db('memberships')
    .where({ organization_id: orgId, team_id: null })
    .select('*')
}

export const getUserOrganizationRole = async (userId: string, organizationId: string): Promise<string | null> => {
  const membership = await db('memberships')
    .where({ user_id: userId, organization_id: organizationId, team_id: null })
    .first()
  return membership ? membership.role : null
}

export const getUserTeamRole = async (userId: string, teamId: string): Promise<string | null> => {
  const membership = await db('memberships')
    .where({ user_id: userId, team_id: teamId })
    .first()
  return membership ? membership.role : null
}

/** Count of org-level members with an admin-level role ('owner' or 'admin'). */
export const countOrgAdmins = async (orgId: string): Promise<number> => {
  const result = await db('memberships')
    .where({ organization_id: orgId, team_id: null })
    .whereIn('role', ['owner', 'admin'])
    .count('* as count')
    .first()
  return Number(result?.count ?? 0)
}

// ─── Mutation operations ──────────────────────────────────────────────────────

/**
 * Remove a user's org-level membership.
 * Throws `LastAdminError` if they are the last admin-level member.
 */
export const removeMembership = async (userId: string, orgId: string): Promise<void> => {
  const membership = await db('memberships')
    .where({ user_id: userId, organization_id: orgId, team_id: null })
    .first()

  if (!membership) {
    throw new Error('Membership not found.')
  }

  if (isAdminRole(membership.role)) {
    const adminCount = await countOrgAdmins(orgId)
    if (adminCount <= 1) {
      throw new LastAdminError()
    }
  }

  await db('memberships')
    .where({ user_id: userId, organization_id: orgId, team_id: null })
    .delete()
}

/**
 * Change the role of an existing org-level membership.
 * Throws `LastAdminError` if downgrading the last admin-level member.
 */
export const updateMemberRole = async (
  userId: string,
  orgId: string,
  newRole: string,
): Promise<Membership> => {
  const membership = await db('memberships')
    .where({ user_id: userId, organization_id: orgId, team_id: null })
    .first()

  if (!membership) {
    throw new Error('Membership not found.')
  }

  if (isAdminRole(membership.role) && !isAdminRole(newRole)) {
    const adminCount = await countOrgAdmins(orgId)
    if (adminCount <= 1) {
      throw new LastAdminError()
    }
  }

  const [updated] = await db('memberships')
    .where({ user_id: userId, organization_id: orgId, team_id: null })
    .update({ role: newRole })
    .returning('*')
  return updated
}
