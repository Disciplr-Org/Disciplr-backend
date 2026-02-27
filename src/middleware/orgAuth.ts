import { Request, Response, NextFunction } from 'express'
import { AuthenticatedRequest } from './auth.js'

export type OrgRole = 'owner' | 'admin' | 'member'

export interface OrgMember {
  orgId: string
  userId: string
  role: OrgRole
}

let orgMembers: OrgMember[] = []

export const setOrgMembers = (members: OrgMember[]) => {
  orgMembers = members
}

export const getMemberRole = (orgId: string, userId: string): OrgRole | null => {
  const membership = orgMembers.find(m => m.orgId === orgId && m.userId === userId)
  return membership ? membership.role : null
}

export const requireOrgAccess = (allowedRoles: OrgRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId || req.query.orgId as string
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!orgId || !userId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }

    const role = getMemberRole(orgId, userId)
    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({ error: 'Insufficient organization permissions' })
      return
    }

    next()
  }
}
