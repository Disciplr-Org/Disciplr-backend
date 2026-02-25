import { TransactionType } from '../types/transactions.js'

export class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class TransactionValidator {
  static validateTransactionType(type: string): TransactionType {
    const validTypes: TransactionType[] = ['creation', 'validation', 'release', 'redirect', 'cancel']
    
    if (!validTypes.includes(type as TransactionType)) {
      throw new ValidationError(`Invalid transaction type: ${type}. Must be one of: ${validTypes.join(', ')}`, 'type')
    }
    
    return type as TransactionType
  }

  static validateAmount(amount: string | number): string {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount
    
    if (isNaN(numAmount) || numAmount < 0) {
      throw new ValidationError('Amount must be a non-negative number', 'amount')
    }
    
    // Validate decimal places (max 7 for Stellar precision)
    const decimalPlaces = numAmount.toString().split('.')[1]?.length || 0
    if (decimalPlaces > 7) {
      throw new ValidationError('Amount cannot have more than 7 decimal places', 'amount')
    }
    
    return numAmount.toString()
  }

  static validateTimestamp(timestamp: string): string {
    const date = new Date(timestamp)
    
    if (isNaN(date.getTime())) {
      throw new ValidationError('Invalid timestamp format', 'timestamp')
    }
    
    // Check if timestamp is not too far in the future (allow 5 minutes for clock skew)
    const now = new Date()
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000)
    
    if (date > fiveMinutesFromNow) {
      throw new ValidationError('Timestamp cannot be more than 5 minutes in the future', 'timestamp')
    }
    
    return date.toISOString()
  }

  static validateStellarAddress(address: string): string {
    if (!address || typeof address !== 'string') {
      throw new ValidationError('Stellar address is required', 'address')
    }
    
    // Basic Stellar address validation (starts with 'G' and 56 characters)
    if (!address.startsWith('G') || address.length !== 56) {
      throw new ValidationError('Invalid Stellar address format', 'address')
    }
    
    return address
  }

  static validateStellarHash(hash: string): string {
    if (!hash || typeof hash !== 'string') {
      throw new ValidationError('Stellar hash is required', 'stellarHash')
    }
    
    // Stellar transaction hash is 64 hex characters
    if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
      throw new ValidationError('Invalid Stellar hash format', 'stellarHash')
    }
    
    return hash.toLowerCase()
  }

  static validateVaultId(vaultId: string): string {
    if (!vaultId || typeof vaultId !== 'string') {
      throw new ValidationError('Vault ID is required', 'vaultId')
    }
    
    if (vaultId.length < 1 || vaultId.length > 255) {
      throw new ValidationError('Vault ID must be between 1 and 255 characters', 'vaultId')
    }
    
    return vaultId
  }

  static validatePagination(page: any, limit: any): { page: number; limit: number } {
    const pageNum = parseInt(page)
    const limitNum = parseInt(limit)
    
    if (isNaN(pageNum) || pageNum < 1) {
      throw new ValidationError('Page must be a positive integer', 'page')
    }
    
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      throw new ValidationError('Limit must be between 1 and 100', 'limit')
    }
    
    return { page: pageNum, limit: limitNum }
  }

  static validateDateRange(startDate?: string, endDate?: string): { startDate?: string; endDate?: string } {
    const result: { startDate?: string; endDate?: string } = {}
    
    if (startDate) {
      const start = new Date(startDate)
      if (isNaN(start.getTime())) {
        throw new ValidationError('Invalid start date format', 'startDate')
      }
      result.startDate = start.toISOString()
    }
    
    if (endDate) {
      const end = new Date(endDate)
      if (isNaN(end.getTime())) {
        throw new ValidationError('Invalid end date format', 'endDate')
      }
      result.endDate = end.toISOString()
    }
    
    // Validate that start date is before end date
    if (result.startDate && result.endDate) {
      const start = new Date(result.startDate)
      const end = new Date(result.endDate)
      
      if (start >= end) {
        throw new ValidationError('Start date must be before end date', 'dateRange')
      }
    }
    
    return result
  }

  static validateAmountRange(minAmount?: string, maxAmount?: string): { minAmount?: string; maxAmount?: string } {
    const result: { minAmount?: string; maxAmount?: string } = {}
    
    if (minAmount) {
      result.minAmount = this.validateAmount(minAmount)
    }
    
    if (maxAmount) {
      result.maxAmount = this.validateAmount(maxAmount)
    }
    
    // Validate that min amount is less than max amount
    if (result.minAmount && result.maxAmount) {
      const min = parseFloat(result.minAmount)
      const max = parseFloat(result.maxAmount)
      
      if (min > max) {
        throw new ValidationError('Minimum amount must be less than maximum amount', 'amountRange')
      }
    }
    
    return result
  }

  static validateLink(link: string): string {
    if (!link || typeof link !== 'string') {
      throw new ValidationError('Link is required', 'link')
    }
    
    try {
      new URL(link)
    } catch {
      throw new ValidationError('Invalid URL format for link', 'link')
    }
    
    return link
  }

  static validateMetadata(metadata: any): Record<string, any> | undefined {
    if (metadata === undefined || metadata === null) {
      return undefined
    }
    
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new ValidationError('Metadata must be a JSON object', 'metadata')
    }
    
    // Validate metadata size (prevent overly large metadata)
    const jsonString = JSON.stringify(metadata)
    if (jsonString.length > 10000) { // 10KB limit
      throw new ValidationError('Metadata is too large (max 10KB)', 'metadata')
    }
    
    return metadata
  }
}
