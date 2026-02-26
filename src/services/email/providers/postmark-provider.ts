import * as postmark from 'postmark'
import type { EmailProvider, EmailParams, EmailResult } from '../../types/email.js'

export class PostmarkProvider implements EmailProvider {
  private client: postmark.ServerClient

  constructor(serverToken: string) {
    this.client = new postmark.ServerClient(serverToken)
  }

  async sendEmail(params: EmailParams): Promise<EmailResult> {
    try {
      const result = await this.client.sendEmail({
        From: params.from || 'noreply@disciplr.com',
        To: Array.isArray(params.to) ? params.to.join(',') : params.to,
        Subject: params.subject,
        HtmlBody: params.html,
        TextBody: params.text,
      })
      
      return {
        success: true,
        messageId: result.MessageID,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown Postmark error',
      }
    }
  }
}
