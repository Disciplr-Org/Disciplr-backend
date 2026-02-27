import db from '../db/index.js'
import type { Membership, CreateMembershipInput } from '../types/enterprise.js'

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
