export { EmailService } from './email-service.js'
export { EmailQueueService } from './email-queue.js'
export { getEmailConfig, validateEmailConfig } from './email-config.js'
export { SESProvider } from './providers/ses-provider.js'
export { SendGridProvider } from './providers/sendgrid-provider.js'
export { PostmarkProvider } from './providers/postmark-provider.js'

export type {
  EmailProvider,
  EmailParams,
  EmailResult,
  EmailConfig,
  EmailTemplate,
  EmailEventType,
  EmailEventPayload,
} from '../../types/email.js'

export type { EmailJobData } from './email-queue.js'
