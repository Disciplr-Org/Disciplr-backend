import { vaults, type Vault } from '../routes/vaults.js'
import { allMilestonesVerified } from './milestones.js'

type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export interface TransitionResult {
  success: boolean
  error?: string
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

const findVault = (vaultId: string): Vault | undefined =>
  vaults.find((v) => v.id === vaultId)

export const getTransitionError = (
  vault: Vault,
  targetStatus: TerminalStatus,
  requesterId?: string,
): string | null => {
  if (TERMINAL_STATUSES.has(vault.status)) {
    return `Vault is already '${vault.status}' and cannot transition`
  }

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

export const completeVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId)
  if (!vault) return { success: false, error: 'Vault not found' }

  const error = getTransitionError(vault, 'completed')
  if (error) return { success: false, error }

  vault.status = 'completed'
  return { success: true }
}

export const failVault = (vaultId: string): TransitionResult => {
  const vault = findVault(vaultId)
  if (!vault) return { success: false, error: 'Vault not found' }

  const error = getTransitionError(vault, 'failed')
  if (error) return { success: false, error }

  vault.status = 'failed'
  return { success: true }
}

export const cancelVault = (vaultId: string, requesterId: string): TransitionResult => {
  const vault = findVault(vaultId)
  if (!vault) return { success: false, error: 'Vault not found' }

  const error = getTransitionError(vault, 'cancelled', requesterId)
  if (error) return { success: false, error }

  vault.status = 'cancelled'
  return { success: true }
}

export const checkExpiredVaults = (): string[] => {
  const now = new Date()
  const failed: string[] = []

  for (const vault of vaults) {
    if (vault.status !== 'active') continue
    const end = new Date(vault.endTimestamp)
    if (end <= now) {
      vault.status = 'failed'
      failed.push(vault.id)
    }
  }

  return failed
}
