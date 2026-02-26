export interface Transaction {
  id: string
  user_id: string
  vault_id: string
  tx_hash: string
  type: 'creation' | 'validation' | 'release' | 'redirect' | 'cancel'
  amount: string
  asset_code: string | null
  from_account: string
  to_account: string
  memo: string | null
  created_at: Date
  stellar_ledger: number
  stellar_timestamp: Date
  explorer_url: string
}

export interface HorizonOperation {
  id: string
  type: string
  transaction_hash: string
  created_at: string
  transaction_successful: boolean
  source_account: string
  
  // Payment specific fields
  amount?: string
  asset_code?: string
  asset_type?: string
  from?: string
  to?: string
  
  // ManageData specific fields
  name?: string
  value?: string
  
  // Transaction details
  ledger: number
  fee_paid: number
  memo?: string
  memo_type?: string
}

export interface ETLConfig {
  horizonUrl: string
  networkPassphrase: string
  backfillFrom?: Date
  backfillTo?: Date
  cursor?: string
  batchSize: number
  maxRetries: number
}

export interface VaultReference {
  id: string
  user_id: string
  creator: string
  verifier: string
  success_destination: string
  failure_destination: string
}
