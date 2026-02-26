import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { EmailQueueService } from './email-queue.js'
import { EmailService } from './email-service.js'
import type { EmailConfig, EmailEventPayload } from '../../types/email.js'

describe('EmailQueueService Integration Tests', () => {
  let emailQueueService: EmailQueueService
  let mockEmailService: EmailService

  const mockConfig: EmailConfig = {
    provider: 'ses',
    fromEmail: 'test@disciplr.com',
    credentials: {
      ses: {
        region: 'us-east-1',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      },
    },
  }

  beforeEach(() => {
    jest.setTimeout(10000)
    mockEmailService = new EmailService(mockConfig)
    
    emailQueueService = new EmailQueueService(mockEmailService, 'redis://localhost:6379')
  })

  afterEach(async () => {
    try {
      await emailQueueService.close()
    } catch (error) {
      console.log('Cleanup error:', error)
    }
  })

  describe('queue operations', () => {
    it('should add email job to queue', async () => {
      const payload: EmailEventPayload = {
        type: 'vault_created',
        recipient: 'test@example.com',
        data: {
          vaultId: 'vault-123',
          amount: '1000',
        },
      }

      await expect(emailQueueService.addEmailJob(payload)).resolves.not.toThrow()
    })

    it('should return queue status', async () => {
      const status = await emailQueueService.getQueueStatus()

      expect(status).toHaveProperty('waiting')
      expect(status).toHaveProperty('active')
      expect(status).toHaveProperty('completed')
      expect(status).toHaveProperty('failed')
      expect(status).toHaveProperty('delayed')

      expect(typeof status.waiting).toBe('number')
      expect(typeof status.active).toBe('number')
      expect(typeof status.completed).toBe('number')
      expect(typeof status.failed).toBe('number')
      expect(typeof status.delayed).toBe('number')
    })
  })

  describe('queue control', () => {
    it('should pause and resume queue', async () => {
      await emailQueueService.pauseQueue()
      await emailQueueService.resumeQueue()

      const status = await emailQueueService.getQueueStatus()
      expect(status).toBeDefined()
    })
  })
})
