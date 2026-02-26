import { Router, Request, Response } from 'express'
import { getNotificationService } from '../services/notification-service.js'
import { validateEmailConfig } from '../services/email/index.js'
import { logger } from '../services/logger.js'
import { createValidationMiddleware } from '../middleware/validation/index.js'
import { 
  sendTestEmailSchema, 
  sendVaultCreatedEmailSchema, 
  sendDeadlineApproachingEmailSchema 
} from '../middleware/validation/schemas.js'

export const emailRouter = Router()

emailRouter.get('/health', (req: Request, res: Response) => {
  try {
    const isValid = validateEmailConfig()
    res.json({
      status: isValid ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Email service health check failed',
      timestamp: new Date().toISOString(),
    })
  }
})

emailRouter.get('/queue/status', async (req: Request, res: Response) => {
  try {
    const notificationService = getNotificationService()
    const status = await notificationService.getQueueStatus()
    
    res.json({
      status: 'success',
      data: status,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error('Failed to get email queue status', { error }, error instanceof Error ? error : new Error(String(error)))
    res.status(500).json({
      status: 'error',
      message: 'Failed to get queue status',
      timestamp: new Date().toISOString(),
    })
  }
})

emailRouter.post('/send/test', 
  createValidationMiddleware(sendTestEmailSchema, { source: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const { to, eventType = 'vault_created', data = {} } = req.body

      const notificationService = getNotificationService()
      await notificationService.sendCustomNotification(to, eventType, data)

      logger.info('Test email sent', { to, eventType })

      res.json({
        status: 'success',
        message: 'Test email queued successfully',
        data: { to, eventType },
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('Failed to send test email', { error, body: req.body }, error instanceof Error ? error : new Error(String(error)))
      res.status(500).json({
        status: 'error',
        message: 'Failed to send test email',
        timestamp: new Date().toISOString(),
      })
    }
  }
)

emailRouter.post('/send/vault-created',
  createValidationMiddleware(sendVaultCreatedEmailSchema, { source: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const { vault, recipientEmail } = req.body

      const notificationService = getNotificationService()
      await notificationService.notifyVaultCreated(vault, recipientEmail)

      logger.info('Vault created notification sent', { vaultId: vault.id, recipientEmail })

      res.json({
        status: 'success',
        message: 'Vault created notification queued successfully',
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('Failed to send vault created notification', { error, body: req.body }, error instanceof Error ? error : new Error(String(error)))
      res.status(500).json({
        status: 'error',
        message: 'Failed to send vault created notification',
        timestamp: new Date().toISOString(),
      })
    }
  }
)

emailRouter.post('/send/deadline-approaching',
  createValidationMiddleware(sendDeadlineApproachingEmailSchema, { source: 'body' }),
  async (req: Request, res: Response) => {
    try {
      const { vault, recipientEmail, timeRemaining } = req.body

      const notificationService = getNotificationService()
      await notificationService.notifyDeadlineApproaching(vault, recipientEmail, timeRemaining)

      logger.info('Deadline approaching notification sent', { vaultId: vault.id, recipientEmail, timeRemaining })

      res.json({
        status: 'success',
        message: 'Deadline approaching notification queued successfully',
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      logger.error('Failed to send deadline approaching notification', { error, body: req.body }, error instanceof Error ? error : new Error(String(error)))
      res.status(500).json({
        status: 'error',
        message: 'Failed to send deadline approaching notification',
        timestamp: new Date().toISOString(),
      })
    }
  }
)
