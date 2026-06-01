export interface MilestoneInput {
  title: string
  description?: string
  dueDate: string
  amount: string
}

export interface CreateVaultInput {
  amount: string
  startDate: string
  endDate: string
  verifier: string
  destinations: {
    success: string
    failure: string
  }
  milestones: MilestoneInput[]
  creator?: string
  /** Grace window in seconds after a milestone dueDate during which check-in is still accepted. Bounded by vault endDate. */
  lateCheckInWindowSecs?: number
  onChain?: {
    mode?: 'build' | 'submit'
    contractId?: string
    networkPassphrase?: string
    sourceAccount?: string
  }
}

export interface PersistedMilestone {
  id: string
  vaultId: string
  title: string
  description: string | null
  dueDate: string
  amount: string
  sortOrder: number
  verifierUserId: string | null
  createdAt: string
}

export interface PersistedVault {
  id: string
  amount: string
  startDate: string
  endDate: string
  verifier: string
  successDestination: string
  failureDestination: string
  creator: string | null
  status: 'draft' | 'active' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  milestones: PersistedMilestone[]
  /** Grace window in seconds after a milestone dueDate during which check-in is still accepted. Bounded by vault endDate. */
  lateCheckInWindowSecs: number
}

export interface VaultCreateResponse {
  vault: PersistedVault
  onChain: {
    mode: 'build' | 'submit'
    payload: {
      contractId: string
      networkPassphrase: string
      sourceAccount: string
      method: 'create_vault'
      args: Record<string, unknown>
    }
    submission: {
      attempted: boolean
      status: 'not_requested' | 'not_configured' | 'success' | 'error'
      txHash?: string
      error?: string | { code: string; message: string; details?: unknown }
    }
  }
  idempotency: {
    key: string | null
    replayed: boolean
  }
}
