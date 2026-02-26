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

// In-memory stores; replace with DB later
export let organizations: Organization[] = []
export let orgMembers: OrgMember[] = []

export const setOrganizations = (orgs: Organization[]) => {
  organizations = orgs
}

export const setOrgMembers = (members: OrgMember[]) => {
  orgMembers = members
}

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
