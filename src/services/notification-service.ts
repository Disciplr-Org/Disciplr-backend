import { EmailService, EmailQueueService, getEmailConfig } from './email/index.js'
import type { EmailEventPayload, EmailEventType } from '../types/email.js'
import type { Vault } from '../routes/vaults.js'

export class NotificationService {
  private emailQueue: EmailQueueService

  constructor() {
    const emailConfig = getEmailConfig()
    const emailService = new EmailService(emailConfig)
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
    
    this.emailQueue = new EmailQueueService(emailService, redisUrl)
  }

  async notifyVaultCreated(vault: Vault, recipientEmail: string): Promise<void> {
    const payload: EmailEventPayload = {
      type: 'vault_created',
      recipient: recipientEmail,
      data: {
        vaultId: vault.id,
        amount: vault.amount,
        startTimestamp: vault.startTimestamp,
        endTimestamp: vault.endTimestamp,
        successDestination: vault.successDestination,
        failureDestination: vault.failureDestination,
        creator: vault.creator,
      },
    }

    await this.emailQueue.addEmailJob(payload)
  }

  async notifyDeadlineApproaching(vault: Vault, recipientEmail: string, timeRemaining: string): Promise<void> {
    const payload: EmailEventPayload = {
      type: 'deadline_approaching',
      recipient: recipientEmail,
      data: {
        vaultId: vault.id,
        amount: vault.amount,
        endTimestamp: vault.endTimestamp,
        timeRemaining,
        creator: vault.creator,
      },
    }

    await this.emailQueue.addEmailJob(payload)
  }

  async notifyFundsReleased(vault: Vault, recipientEmail: string, transactionData: {
    destination: string
    transactionId: string
    releaseDate: string
  }): Promise<void> {
    const payload: EmailEventPayload = {
      type: 'funds_released',
      recipient: recipientEmail,
      data: {
        vaultId: vault.id,
        amount: vault.amount,
        destination: transactionData.destination,
        transactionId: transactionData.transactionId,
        releaseDate: transactionData.releaseDate,
        creator: vault.creator,
      },
    }

    await this.emailQueue.addEmailJob(payload)
  }

  async notifyFundsRedirected(vault: Vault, recipientEmail: string, redirectData: {
    originalDestination: string
    newDestination: string
    reason: string
    transactionId: string
  }): Promise<void> {
    const payload: EmailEventPayload = {
      type: 'funds_redirected',
      recipient: recipientEmail,
      data: {
        vaultId: vault.id,
        amount: vault.amount,
        originalDestination: redirectData.originalDestination,
        newDestination: redirectData.newDestination,
        reason: redirectData.reason,
        transactionId: redirectData.transactionId,
        creator: vault.creator,
      },
    }

    await this.emailQueue.addEmailJob(payload)
  }

  async notifyVerificationRequested(vault: Vault, recipientEmail: string, verificationData: {
    verificationType: string
    requestedBy: string
    requestDate: string
    deadline: string
  }): Promise<void> {
    const payload: EmailEventPayload = {
      type: 'verification_requested',
      recipient: recipientEmail,
      data: {
        vaultId: vault.id,
        verificationType: verificationData.verificationType,
        requestedBy: verificationData.requestedBy,
        requestDate: verificationData.requestDate,
        deadline: verificationData.deadline,
        creator: vault.creator,
      },
    }

    await this.emailQueue.addEmailJob(payload)
  }

  async sendCustomNotification(
    recipientEmail: string,
    eventType: EmailEventType,
    data: Record<string, any>
  ): Promise<void> {
    const payload: EmailEventPayload = {
      type: eventType,
      recipient: recipientEmail,
      data,
    }

    await this.emailQueue.addEmailJob(payload)
  }

  async getQueueStatus() {
    return await this.emailQueue.getQueueStatus()
  }

  async shutdown(): Promise<void> {
    await this.emailQueue.close()
  }
}

let notificationServiceInstance: NotificationService | null = null

export function getNotificationService(): NotificationService {
  if (!notificationServiceInstance) {
    notificationServiceInstance = new NotificationService()
  }
  return notificationServiceInstance
}

export function resetNotificationService(): void {
  notificationServiceInstance = null
}
