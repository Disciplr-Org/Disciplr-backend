export type TransactionType = 'creation' | 'validation' | 'release' | 'redirect' | 'cancel'

export interface Transaction {
  id: string
  userId: string
  vaultId: string
  type: TransactionType
  amount: string
  timestamp: string
  stellarHash?: string
  link?: string
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
}

export interface CreateTransactionRequest {
  userId: string
  vaultId: string
  type: TransactionType
  amount: string
  timestamp: string
  stellarHash?: string
  link?: string
  metadata?: Record<string, any>
}

export interface TransactionFilters {
  type?: TransactionType
  vault?: string
  startDate?: string
  endDate?: string
  minAmount?: string
  maxAmount?: string
  userId?: string
}

export interface TransactionListResponse {
  transactions: Transaction[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}
