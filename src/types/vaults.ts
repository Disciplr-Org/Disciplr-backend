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
  orgId?: string
  onChain?: {
    mode?: 'build' | 'submit'
    contractId?: string
    networkPassphrase?: string
    sourceAccount?: string
    /** SEP-41 token contract address. SAC (Stellar Asset Contract) by default;
     *  pass a Wasm-based token address to test generic SEP-41 compliance. */
    token?: string
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
  orgId?: string
}

export interface StakeInput {
  vaultId: string
  amount: string
  user: string
  onChain?: {
    mode?: 'build' | 'submit'
    contractId?: string
    networkPassphrase?: string
    sourceAccount?: string
  }
}

export interface StakeResponse {
  mode: 'build' | 'submit'
  payload: {
    contractId: string
    networkPassphrase: string
    sourceAccount: string
    method: 'stake'
    args: Record<string, unknown>
  }
  submission: {
    attempted: boolean
    status: 'not_requested' | 'not_configured' | 'success' | 'error'
    txHash?: string
    error?: string
  }
}

export interface StakeWithMemoInput {
  vaultId: string
  amount: string
  user: string
  memo?: string
  onChain?: {
    mode?: 'build' | 'submit'
    contractId?: string
    networkPassphrase?: string
    sourceAccount?: string
  }
}

export interface StakeWithMemoResponse {
  mode: 'build' | 'submit'
  payload: {
    contractId: string
    networkPassphrase: string
    sourceAccount: string
    method: 'stake_with_memo'
    args: Record<string, unknown>
  }
  submission: {
    attempted: boolean
    status: 'not_requested' | 'not_configured' | 'success' | 'error'
    txHash?: string
    error?: string
  }
}

export class MemoTooLongError extends Error {
  constructor(bytes: number, max: number) {
    super(`Memo exceeds maximum length: ${bytes} bytes > ${max} bytes`)
    this.name = 'MemoTooLongError'
  }
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
