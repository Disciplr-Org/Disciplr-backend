import { vaults, type Vault } from '../routes/vaults.js'
import { allMilestonesVerified } from './milestones.js'

export type VaultStatus = 'draft' | 'active' | 'completed' | 'failed' | 'cancelled'
type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export interface TransitionResult {
  success: boolean
  error?: string
}

// ========== STATE MACHINE DEFINITIONS (Issue #208) ==========

// Allowed transitions from each status
const ALLOWED_TRANSITIONS: Record<VaultStatus, VaultStatus[]> = {
  draft: ['active', 'cancelled'],
  active: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'draft'])

const findVault = (vaultId: string): Vault | undefined =>
  vaults.find((v) => v.id === vaultId)

/**
 * Check if a transition is valid based on state machine rules
 */
export const isValidTransition = (
  currentStatus: string,
  targetStatus: TerminalStatus
): boolean => {
  const allowed = ALLOWED_TRANSITIONS[currentStatus as VaultStatus]
  return allowed?.includes(targetStatus) || false
}

/**
 * Get transition error with detailed message
 */
export const getTransitionError = (
  vault: Vault,
  targetStatus: TerminalStatus,
  requesterId?: string,
): string | null => {
  // Check if already in terminal status
  if (TERMINAL_STATUSES.has(vault.status)) {
    return `Vault is already '${vault.status}' and cannot transition`
  }

  // Check if transition is allowed by state machine
  if (!isValidTransition(vault.status, targetStatus)) {
    const allowed = ALLOWED_TRANSITIONS[vault.status as VaultStatus]
    return `Invalid transition: '${vault.status}' -> '${targetStatus}'. Allowed transitions: ${allowed?.join(', ') || 'none'}`
  }

  // Status-specific validations
  switch (targetStatus) {
    case 'completed': {
      if (!allMilestonesVerified(vault.id)) {
        return 'Cannot complete vault: not all milestones are verified'
      }
      return null
    }
    case 'failed': {
      const now = new Date()
      const end = new Date(vault.endTimestamp)
      if (end > now) {
        return 'Cannot fail vault: endTimestamp has not passed yet'
      }
      return null
    }
    case 'cancelled': {
      if (!requesterId || requesterId !== vault.creator) {
        return 'Cannot cancel vault: only the creator can cancel'
      }
      return null
    }
    default:
      return `Unknown target status: ${targetStatus as string}`
  }
}

/**
 * Complete a vault (active -> completed)
 */
export const completeVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId)
  if (!vault) return { success: false, error: 'Vault not found' }

  const error = getTransitionError(vault, 'completed')
  if (error) return { success: false, error }

  vault.status = 'completed'
  return { success: true }
}

/**
 * Fail a vault (active -> failed)
 */
export const failVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId)
  if (!vault) return { success: false, error: 'Vault not found' }

  const error = getTransitionError(vault, 'failed')
  if (error) return { success: false, error }

  vault.status = 'failed'
  return { success: true }
}

/**
 * Cancel a vault (draft/active -> cancelled)
 */
export const cancelVault = (vaultId: string, requesterId: string): TransitionResult => {
  const vault = findVault(vaultId)
  if (!vault) return { success: false, error: 'Vault not found' }

  const error = getTransitionError(vault, 'cancelled', requesterId)
  if (error) return { success: false, error }

  vault.status = 'cancelled'
  return { success: true }
}

/**
 * Mark vault as active (draft -> active)
 */
export const activateVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId)
  if (!vault) return { success: false, error: 'Vault not found' }

  if (vault.status !== 'draft') {
    return { success: false, error: `Cannot activate vault: current status is '${vault.status}', expected 'draft'` }
  }

  vault.status = 'active'
  return { success: true }
}

/**
 * Check and expire vaults that have passed their end timestamp
 */
export const checkExpiredVaults = (): string[] => {
  const now = new Date()
  const failed: string[] = []

  for (const vault of vaults) {
    if (vault.status !== 'active') continue
    const end = new Date(vault.endTimestamp)
    if (end <= now) {
      const result = failVault(vault.id)
      if (result.success) {
        failed.push(vault.id)
      }
    }
  }

  return failed
}

/**
 * Get current state machine state for a vault
 */
export const getVaultState = (vaultId: string): { status: string; isTerminal: boolean; isActive: boolean } | null => {
  const vault = findVault(vaultId)
  if (!vault) return null
  
  return {
    status: vault.status,
    isTerminal: TERMINAL_STATUSES.has(vault.status),
    isActive: ACTIVE_STATUSES.has(vault.status),
  }
}

/**
 * Get allowed next states for a vault
 */
export const getAllowedNextStates = (vaultId: string): VaultStatus[] => {
  const vault = findVault(vaultId)
  if (!vault) return []
  
  return ALLOWED_TRANSITIONS[vault.status as VaultStatus] || []
}