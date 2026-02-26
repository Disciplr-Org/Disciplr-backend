import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { EmailService } from './email-service.js'
import type { EmailConfig, EmailParams } from '../../types/email.js'

describe('EmailService', () => {
  let emailService: EmailService
  let mockProvider: any

  const mockConfig: EmailConfig = {
    provider: 'ses',
    fromEmail: 'test@disciplr.com',
    fromName: 'Test Disciplr',
    credentials: {
      ses: {
        region: 'us-east-1',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      },
    },
  }

  beforeEach(() => {
    mockProvider = {
      sendEmail: jest.fn(),
    }

    jest.mock('./providers/ses-provider.js', () => {
      return {
        SESProvider: jest.fn().mockImplementation(() => mockProvider),
      }
    })

    emailService = new EmailService(mockConfig)
  })

  describe('constructor', () => {
    it('should create email service with SES provider', () => {
      expect(emailService).toBeInstanceOf(EmailService)
    })

    it('should throw error for unsupported provider', () => {
      const invalidConfig = {
        ...mockConfig,
        provider: 'invalid' as any,
      }
      expect(() => new EmailService(invalidConfig)).toThrow('Unsupported email provider')
    })
  })

  describe('sendEmail', () => {
    const emailParams: EmailParams = {
      to: 'test@example.com',
      subject: 'Test Subject',
      html: '<p>Test HTML</p>',
      text: 'Test text',
    }

    it('should send email successfully', async () => {
      mockProvider.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id',
      })

      const result = await emailService.sendEmail(emailParams)

      expect(result.success).toBe(true)
      expect(result.messageId).toBe('test-message-id')
      expect(mockProvider.sendEmail).toHaveBeenCalledWith({
        ...emailParams,
        from: 'Test Disciplr <test@disciplr.com>',
      })
    })

    it('should handle email sending failure', async () => {
      mockProvider.sendEmail.mockResolvedValue({
        success: false,
        error: 'Provider error',
      })

      const result = await emailService.sendEmail(emailParams)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Provider error')
    })

    it('should handle provider exception', async () => {
      mockProvider.sendEmail.mockRejectedValue(new Error('Network error'))

      const result = await emailService.sendEmail(emailParams)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })

  describe('sendEventEmail', () => {
    const eventPayload = {
      type: 'vault_created' as const,
      recipient: 'test@example.com',
      data: {
        vaultId: 'vault-123',
        amount: '1000',
        startTimestamp: '2024-01-01T00:00:00Z',
        endTimestamp: '2024-12-31T23:59:59Z',
        successDestination: 'success-wallet',
        failureDestination: 'failure-wallet',
      },
    }

    it('should send vault created email', async () => {
      mockProvider.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id',
      })

      const result = await emailService.sendEventEmail(eventPayload)

      expect(result.success).toBe(true)
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@example.com',
          subject: 'Vault Created: vault-123',
          html: expect.stringContaining('Vault Created Successfully'),
          text: expect.stringContaining('Vault Created Successfully'),
        })
      )
    })

    it('should handle deadline approaching email', async () => {
      mockProvider.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id',
      })

      const deadlinePayload = {
        type: 'deadline_approaching' as const,
        recipient: 'test@example.com',
        data: {
          vaultId: 'vault-123',
          amount: '1000',
          endTimestamp: '2024-12-31T23:59:59Z',
          timeRemaining: '2 days',
        },
      }

      const result = await emailService.sendEventEmail(deadlinePayload)

      expect(result.success).toBe(true)
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Deadline Approaching for Vault vault-123',
          html: expect.stringContaining('Deadline Approaching'),
        })
      )
    })

    it('should handle unknown event type', async () => {
      mockProvider.sendEmail.mockResolvedValue({
        success: true,
        messageId: 'test-message-id',
      })

      const unknownPayload = {
        type: 'unknown_event' as any,
        recipient: 'test@example.com',
        data: {},
      }

      const result = await emailService.sendEventEmail(unknownPayload)

      expect(result.success).toBe(true)
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Disciplr Notification',
          html: '<p>You have a new notification from Disciplr.</p>',
        })
      )
    })
  })
})
