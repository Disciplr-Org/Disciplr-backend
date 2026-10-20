import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { getVaultById } from './vaultStore.js'
import { UserRole } from '../types/user.js'
import { getMemberRole, isOrgMember } from '../models/organizations.js'
import db from '../db/index.js'
import type { PersistedVault } from '../types/vaults.js'

export interface VaultActor {
  userId?: string | null
  role?: string | null
  orgId?: string | null
  orgRole?: string | null
  walletAddress?: string | null
}

/**
 * Resolves the acting principal from verified auth context (JWT or API-key).
 */
export function resolveVaultActor(req: Request): VaultActor {
  const userId = req.user?.userId ?? req.apiKeyAuth?.userId ?? null
  const role = req.user?.role ?? null
  const orgId = req.apiKeyAuth?.orgId ?? req.user?.enterpriseId ?? (req as any).orgId ?? null
  const walletAddress = req.header('x-wallet-address') ?? (req.user as any)?.walletAddress ?? null

  return {
    userId,
    role,
    orgId,
    walletAddress,
  }
}

/**
 * Synchronous authorisation check: can the given actor read this vault?
 *
 * Readers are:
 * - Admins (can also read soft-deleted vaults)
 * - Creator
 * - Vault primary verifier
 * - Milestone verifiers (milestones.verifier_user_id or multi-verifier tables)
 * - Org members with a read role ('owner', 'admin', 'member') when organization_id is set
 *
 * Soft-deleted vaults stay hidden (returns false) for all non-admins, including creators.
 */
export function canReadVault(
  actor: VaultActor | null | undefined,
  vault: PersistedVault | any,
): boolean {
  if (!vault) return false

  const isAdmin =
    actor?.role === UserRole.ADMIN ||
    actor?.role === 'ADMIN' ||
    actor?.role?.toUpperCase() === 'ADMIN'

  // Soft-deleted vaults stay hidden even from creators, unless they are an admin.
  const isDeleted = Boolean(vault.deletedAt || vault.deleted_at)
  if (isDeleted && !isAdmin) {
    return false
  }

  // Admins can read any vault (including soft-deleted).
  if (isAdmin) {
    return true
  }

  if (!actor) return false

  const actorIds = [actor.userId, actor.walletAddress].filter(Boolean) as string[]

  // 1. Vault creator
  if (vault.creator && actorIds.includes(vault.creator)) {
    return true
  }

  // 2. Primary verifier
  if (vault.verifier && actorIds.includes(vault.verifier)) {
    return true
  }

  // 3. Verifiers assigned through milestones.verifier_user_id or multi-verifier tables
  if (Array.isArray(vault.milestones)) {
    for (const m of vault.milestones) {
      if (m.verifierUserId && actorIds.includes(m.verifierUserId)) {
        return true
      }
      if (m.verifier_user_id && actorIds.includes(m.verifier_user_id)) {
        return true
      }
      if (Array.isArray(m.verifiers)) {
        for (const v of m.verifiers) {
          const id = typeof v === 'string' ? v : (v.userId || v.verifier_user_id || v.verifierUserId)
          if (id && actorIds.includes(id)) {
            return true
          }
        }
      }
      if (Array.isArray(m.approvals)) {
        for (const a of m.approvals) {
          const id = typeof a === 'string' ? a : (a.verifier_user_id || a.verifierUserId || a.userId)
          if (id && actorIds.includes(id)) {
            return true
          }
        }
      }
    }
  }

  if (Array.isArray(vault.verifiers)) {
    for (const v of vault.verifiers) {
      const id = typeof v === 'string' ? v : (v.userId || v.verifier_user_id || v.verifierUserId)
      if (id && actorIds.includes(id)) {
        return true
      }
    }
  }

  if (Array.isArray(vault.verifierUserIds)) {
    for (const id of vault.verifierUserIds) {
      if (actorIds.includes(id)) {
        return true
      }
    }
  }

  // 4. Org members with a read role when organization_id is set
  const vaultOrgId = vault.organization_id ?? vault.orgId
  if (vaultOrgId) {
    const validReadRoles = ['owner', 'admin', 'member']

    if (actor.orgId === vaultOrgId) {
      if (!actor.orgRole || validReadRoles.includes(actor.orgRole.toLowerCase())) {
        return true
      }
    }

    if (actor.userId) {
      const role = getMemberRole(vaultOrgId, actor.userId)
      if (role && validReadRoles.includes(role.toLowerCase())) {
        return true
      }
      if (isOrgMember(vaultOrgId, actor.userId)) {
        return true
      }
    }
  }

  return false
}

/**
 * Express middleware helper that loads the vault once, verifies read authorization,
 * stores the vault on `res.locals.vault`, and returns 404 when access is denied or not found.
 */
export const requireVaultReadAccess: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const vaultId = req.params.vaultId || req.params.id
    if (!vaultId) {
      res.status(404).json({ error: 'Vault not found' })
      return
    }

    const vault = await getVaultById(vaultId)
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' })
      return
    }

    const actor = resolveVaultActor(req)

    // If vault is org-scoped and actor has a userId but no orgRole yet, check DB if available
    const vaultOrgId = vault.organization_id ?? vault.orgId
    if (vaultOrgId && actor.userId && !actor.orgRole) {
      try {
        const membership = await db('org_members')
          .where({ org_id: vaultOrgId, user_id: actor.userId })
          .first()
        if (membership) {
          actor.orgId = vaultOrgId
          actor.orgRole = membership.role
        }
      } catch {
        // DB not available or table doesn't exist; memory store fallback is already checked in canReadVault
      }
    }

    // Check multi-verifier approvals table if not yet authorized and DB available
    let hasAccess = canReadVault(actor, vault)
    if (!hasAccess && actor.userId && vault.milestones?.length) {
      try {
        const milestoneIds = vault.milestones.map((m: any) => m.id)
        const approval = await db('milestone_approvals')
          .whereIn('milestone_id', milestoneIds)
          .andWhere({ verifier_user_id: actor.userId })
          .first()
        if (approval) {
          hasAccess = true
        }
      } catch {
        // DB not available
      }
    }

    if (!hasAccess) {
      res.status(404).json({ error: 'Vault not found' })
      return
    }

    res.locals.vault = vault
    next()
  } catch (err) {
    next(err)
  }
}
