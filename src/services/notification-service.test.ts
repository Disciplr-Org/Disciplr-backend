import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { NotificationService, getNotificationService, resetNotificationService } from './notification-service.js'
import type { Vault } from '../routes/vaults.js'

describe('NotificationService', () => {
  let notificationService: NotificationService
  let mockEmailQueue: any

  const mockVault: Vault = {
    id: 'vault-123',
    creator: 'user-123',
    amount: '1000',
    startTimestamp: '2024-01-01T00:00:00Z',
    endTimestamp: '2024-12-31T23:59:59Z',
    successDestination: 'success-wallet',
    failureDestination: 'failure-wallet',
    status: 'active',
    createdAt: '2024-01-01T00:00:00Z',
  }

  beforeEach(() => {
    mockEmailQueue = {
      addEmailJob: jest.fn(),
      getQueueStatus: jest.fn(),
      close: jest.fn(),
    }

    jest.mock('./email/email-queue.js', () => {
      return {
        EmailQueueService: jest.fn().mockImplementation(() => mockEmailQueue),
      }
    })

    notificationService = new NotificationService()
  })

  afterEach(() => {
    resetNotificationService()
  })

  describe('notifyVaultCreated', () => {
    it('should add vault created email job to queue', async () => {
      mockEmailQueue.addEmailJob.mockResolvedValue(undefined)

      await notificationService.notifyVaultCreated(mockVault, 'test@example.com')

      expect(mockEmailQueue.addEmailJob).toHaveBeenCalledWith({
        type: 'vault_created',
        recipient: 'test@example.com',
        data: {
          vaultId: 'vault-123',
          amount: '1000',
          startTimestamp: '2024-01-01T00:00:00Z',
          endTimestamp: '2024-12-31T23:59:59Z',
          successDestination: 'success-wallet',
          failureDestination: 'failure-wallet',
          creator: 'user-123',
        },
      })
    })
  })

  describe('notifyDeadlineApproaching', () => {
    it('should add deadline approaching email job to queue', async () => {
      mockEmailQueue.addEmailJob.mockResolvedValue(undefined)

      await notificationService.notifyDeadlineApproaching(mockVault, 'test@example.com', '2 days')

      expect(mockEmailQueue.addEmailJob).toHaveBeenCalledWith({
        type: 'deadline_approaching',
        recipient: 'test@example.com',
        data: {
          vaultId: 'vault-123',
          amount: '1000',
          endTimestamp: '2024-12-31T23:59:59Z',
          timeRemaining: '2 days',
          creator: 'user-123',
        },
      })
    })
  })

  describe('notifyFundsReleased', () => {
    it('should add funds released email job to queue', async () => {
      mockEmailQueue.addEmailJob.mockResolvedValue(undefined)

      const transactionData = {
        destination: 'recipient-wallet',
        transactionId: 'tx-123',
        releaseDate: '2024-06-15T00:00:00Z',
      }

      await notificationService.notifyFundsReleased(mockVault, 'test@example.com', transactionData)

      expect(mockEmailQueue.addEmailJob).toHaveBeenCalledWith({
        type: 'funds_released',
        recipient: 'test@example.com',
        data: {
          vaultId: 'vault-123',
          amount: '1000',
          destination: 'recipient-wallet',
          transactionId: 'tx-123',
          releaseDate: '2024-06-15T00:00:00Z',
          creator: 'user-123',
        },
      })
    })
  })

  describe('notifyFundsRedirected', () => {
    it('should add funds redirected email job to queue', async () => {
      mockEmailQueue.addEmailJob.mockResolvedValue(undefined)

      const redirectData = {
        originalDestination: 'original-wallet',
        newDestination: 'new-wallet',
        reason: 'User requested change',
        transactionId: 'tx-456',
      }

      await notificationService.notifyFundsRedirected(mockVault, 'test@example.com', redirectData)

      expect(mockEmailQueue.addEmailJob).toHaveBeenCalledWith({
        type: 'funds_redirected',
        recipient: 'test@example.com',
        data: {
          vaultId: 'vault-123',
          amount: '1000',
          originalDestination: 'original-wallet',
          newDestination: 'new-wallet',
          reason: 'User requested change',
          transactionId: 'tx-456',
          creator: 'user-123',
        },
      })
    })
  })

  describe('notifyVerificationRequested', () => {
    it('should add verification requested email job to queue', async () => {
      mockEmailQueue.addEmailJob.mockResolvedValue(undefined)

      const verificationData = {
        verificationType: 'identity',
        requestedBy: 'admin',
        requestDate: '2024-06-15T00:00:00Z',
        deadline: '2024-06-22T00:00:00Z',
      }

      await notificationService.notifyVerificationRequested(mockVault, 'test@example.com', verificationData)

      expect(mockEmailQueue.addEmailJob).toHaveBeenCalledWith({
        type: 'verification_requested',
        recipient: 'test@example.com',
        data: {
          vaultId: 'vault-123',
          verificationType: 'identity',
          requestedBy: 'admin',
          requestDate: '2024-06-15T00:00:00Z',
          deadline: '2024-06-22T00:00:00Z',
          creator: 'user-123',
        },
      })
    })
  })

  describe('sendCustomNotification', () => {
    it('should add custom email job to queue', async () => {
      mockEmailQueue.addEmailJob.mockResolvedValue(undefined)

      await notificationService.sendCustomNotification(
        'test@example.com',
        'vault_created',
        { customField: 'custom value' }
      )

      expect(mockEmailQueue.addEmailJob).toHaveBeenCalledWith({
        type: 'vault_created',
        recipient: 'test@example.com',
        data: { customField: 'custom value' },
      })
    })
  })

  describe('getQueueStatus', () => {
    it('should return queue status', async () => {
      const mockStatus = {
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 1,
        delayed: 3,
      }
      mockEmailQueue.getQueueStatus.mockResolvedValue(mockStatus)

      const result = await notificationService.getQueueStatus()

      expect(result).toEqual(mockStatus)
      expect(mockEmailQueue.getQueueStatus).toHaveBeenCalled()
    })
  })

  describe('singleton pattern', () => {
    it('should return same instance', () => {
      const service1 = getNotificationService()
      const service2 = getNotificationService()
      expect(service1).toBe(service2)
    })

    it('should create new instance after reset', () => {
      const service1 = getNotificationService()
      resetNotificationService()
      const service2 = getNotificationService()
      expect(service1).not.toBe(service2)
    })
  })
})
