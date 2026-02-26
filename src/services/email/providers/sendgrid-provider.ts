import sgMail from '@sendgrid/mail'
import type { EmailProvider, EmailParams, EmailResult } from '../../types/email.js'

export class SendGridProvider implements EmailProvider {
  constructor(apiKey: string) {
    sgMail.setApiKey(apiKey)
  }

  async sendEmail(params: EmailParams): Promise<EmailResult> {
    try {
      const msg = {
        to: Array.isArray(params.to) ? params.to : [params.to],
        from: params.from || 'noreply@disciplr.com',
        subject: params.subject,
        html: params.html,
        text: params.text,
      }

      const result = await sgMail.send(msg)
      
      return {
        success: true,
        messageId: result[0]?.headers?.['x-message-id'],
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown SendGrid error',
      }
    }
  }
}
