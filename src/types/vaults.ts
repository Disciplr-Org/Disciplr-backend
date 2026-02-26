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
      status: 'not_requested' | 'not_configured'
    }
  }
  idempotency: {
    key: string | null
    replayed: boolean
  }
}
