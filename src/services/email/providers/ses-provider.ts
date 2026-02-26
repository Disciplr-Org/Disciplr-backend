import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import type { EmailProvider, EmailParams, EmailResult } from '../../types/email.js'

export class SESProvider implements EmailProvider {
  private client: SESClient
  private region: string

  constructor(config: { region: string; accessKeyId: string; secretAccessKey: string }) {
    this.region = config.region
    this.client = new SESClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  async sendEmail(params: EmailParams): Promise<EmailResult> {
    try {
      const command = new SendEmailCommand({
        Destination: {
          ToAddresses: Array.isArray(params.to) ? params.to : [params.to],
        },
        Message: {
          Body: {
            Html: params.html ? { Charset: 'UTF-8', Data: params.html } : undefined,
            Text: params.text ? { Charset: 'UTF-8', Data: params.text } : undefined,
          },
          Subject: { Charset: 'UTF-8', Data: params.subject },
        },
        Source: params.from || 'noreply@disciplr.com',
      })

      const result = await this.client.send(command)
      
      return {
        success: true,
        messageId: result.MessageId,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown SES error',
      }
    }
  }
}
