export interface Organization {
  id: string
  name: string
  createdAt: string
}

export type OrgRole = 'owner' | 'admin' | 'member'

export interface OrgMember {
  orgId: string
  userId: string
  role: OrgRole
}

// In-memory stores (replaced by DB in production) 
export let organizations: Organization[] = []
export let orgMembers: OrgMember[] = []

export const setOrganizations = (orgs: Organization[]): void => {
  organizations = orgs
}

export const setOrgMembers = (members: OrgMember[]): void => {
  orgMembers = members
}

// Read helpers

export function getOrganization(orgId: string): Organization | undefined {
  return organizations.find((o) => o.id === orgId)
}

export function getOrgMembers(orgId: string): OrgMember[] {
  return orgMembers.filter((m) => m.orgId === orgId)
}

export function isOrgMember(orgId: string, userId: string): boolean {
  return orgMembers.some((m) => m.orgId === orgId && m.userId === userId)
}

export function getMemberRole(orgId: string, userId: string): OrgRole | undefined {
  const member = orgMembers.find((m) => m.orgId === orgId && m.userId === userId)
  return member?.role
}

// Membership rules 

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

/** Returns true for roles that carry admin-level privileges. */
const isAdminRole = (role: string): boolean => role === 'owner' || role === 'admin'

/** Count of members in the org that hold an admin-level role. */
export function countOrgAdmins(orgId: string): number {
  return orgMembers.filter((m) => m.orgId === orgId && isAdminRole(m.role)).length
}

// Mutation helpers 

/**
 * Add a new member to an org. Throws if the user is already a member.
 */
export function addOrgMember(member: OrgMember): void {
  const already = orgMembers.find((m) => m.orgId === member.orgId && m.userId === member.userId)
  if (already) {
    throw new Error(`User ${member.userId} is already a member of org ${member.orgId}.`)
  }
  orgMembers = [...orgMembers, member]
}

/**
 * Remove a member from an org.
 * Throws `LastAdminError` if they are the last admin-level member.
 * Throws if the membership does not exist.
 */
export function removeOrgMember(orgId: string, userId: string): void {
  const member = orgMembers.find((m) => m.orgId === orgId && m.userId === userId)
  if (!member) {
    throw new Error('Membership not found.')
  }

  if (isAdminRole(member.role) && countOrgAdmins(orgId) <= 1) {
    throw new LastAdminError()
  }

  orgMembers = orgMembers.filter((m) => !(m.orgId === orgId && m.userId === userId))
}

/**
 * Change the role of an existing member.
 * Throws `LastAdminError` if downgrading the last admin-level member.
 * Throws if the membership does not exist.
 */
export function updateOrgMemberRole(orgId: string, userId: string, newRole: OrgRole): void {
  const idx = orgMembers.findIndex((m) => m.orgId === orgId && m.userId === userId)
  if (idx === -1) {
    throw new Error('Membership not found.')
  }

  const current = orgMembers[idx]

  if (isAdminRole(current.role) && !isAdminRole(newRole) && countOrgAdmins(orgId) <= 1) {
    throw new LastAdminError()
  }

  const updated = [...orgMembers]
  updated[idx] = { ...current, role: newRole }
  orgMembers = updated
}
