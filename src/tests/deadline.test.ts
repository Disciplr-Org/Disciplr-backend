import { jest, beforeAll, describe, it, expect } from '@jest/globals'

// Mock database
const mockDb = {
  insert: jest.fn<any>().mockReturnThis(),
  returning: jest.fn<any>().mockReturnThis(),
  where: jest.fn<any>().mockReturnThis(),
  andWhere: jest.fn<any>().mockReturnThis(),
  whereIn: jest.fn<any>().mockReturnThis(),
  update: jest.fn<any>().mockReturnThis(),
  select: jest.fn<any>().mockReturnThis(),
  orderBy: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>().mockResolvedValue({}),
}

jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn<any>(() => mockDb),
}))

// We need to mock NotificationService too
const mockNotificationService = {
  createNotification: jest.fn<any>().mockResolvedValue({}),
}
jest.unstable_mockModule('../services/notification.js', () => mockNotificationService)

let markVaultExpiries: any

beforeAll(async () => {
  const vaultModule = await import('../services/vault.js')
  markVaultExpiries = vaultModule.markVaultExpiries
})

describe('Deadline Monitoring', () => {
  it('should mark active vaults past deadline as failed', async () => {
    const expiredVault = {
      id: 'vault-expired',
      creator: 'user-1',
      status: 'active',
      end_timestamp: '2020-01-01T00:00:00.000Z'
    }
    
    mockDb.select.mockResolvedValueOnce([expiredVault])
    mockDb.whereIn.mockReturnThis()
    mockDb.update.mockResolvedValueOnce(1)
    
    const count = await markVaultExpiries()
    
    expect(count).toBe(1)
    expect(mockDb.update).toHaveBeenCalledWith({ status: 'failed' })
    expect(mockNotificationService.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-1',
      type: 'vault_failure'
    }))
  })

  it('should return 0 if no vaults are expired', async () => {
    mockDb.select.mockResolvedValueOnce([])
    
    const count = await markVaultExpiries()
    
    expect(count).toBe(0)
    expect(mockDb.update).not.toHaveBeenCalled()
  })
})
