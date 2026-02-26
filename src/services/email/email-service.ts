import { SESProvider } from './providers/ses-provider.js'
import { SendGridProvider } from './providers/sendgrid-provider.js'
import { PostmarkProvider } from './providers/postmark-provider.js'
import { logger } from '../logger.js'
import type { EmailProvider, EmailConfig, EmailParams, EmailResult, EmailEventPayload } from '../../types/email.js'

export class EmailService {
  private provider: EmailProvider
  private config: EmailConfig

  constructor(config: EmailConfig) {
    this.config = config
    this.provider = this.createProvider(config)
  }

  private createProvider(config: EmailConfig): EmailProvider {
    switch (config.provider) {
      case 'ses':
        if (!config.credentials.ses) {
          throw new Error('SES credentials are required')
        }
        return new SESProvider(config.credentials.ses)
      
      case 'sendgrid':
        if (!config.credentials.sendgrid) {
          throw new Error('SendGrid API key is required')
        }
        return new SendGridProvider(config.credentials.sendgrid.apiKey)
      
      case 'postmark':
        if (!config.credentials.postmark) {
          throw new Error('Postmark server token is required')
        }
        return new PostmarkProvider(config.credentials.postmark.serverToken)
      
      default:
        throw new Error(`Unsupported email provider: ${config.provider}`)
    }
  }

  async sendEmail(params: EmailParams): Promise<EmailResult> {
    const emailParams = {
      ...params,
      from: params.from || `${this.config.fromName || 'Disciplr'} <${this.config.fromEmail}>`,
    }

    try {
      const result = await this.provider.sendEmail(emailParams)
      
      if (result.success) {
        logger.emailInfo('Email sent successfully', {
          recipient: Array.isArray(params.to) ? params.to.join(', ') : params.to,
          eventType: params.templateData?.type,
        })
      } else {
        logger.emailError('Email sending failed', {
          recipient: Array.isArray(params.to) ? params.to.join(', ') : params.to,
          eventType: params.templateData?.type,
        }, new Error(result.error))
      }
      
      return result
    } catch (error) {
      logger.emailError('Unexpected error during email sending', {
        recipient: Array.isArray(params.to) ? params.to.join(', ') : params.to,
        eventType: params.templateData?.type,
      }, error instanceof Error ? error : new Error(String(error)))
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }
    }
  }

  async sendEventEmail(payload: EmailEventPayload): Promise<EmailResult> {
    const templateData = this.getTemplateData(payload.type, payload.data)
    
    return await this.sendEmail({
      to: payload.recipient,
      subject: templateData.subject,
      html: templateData.html,
      text: templateData.text,
    })
  }

  private getTemplateData(type: string, data: Record<string, any>) {
    const templates = {
      vault_created: {
        subject: `Vault Created: ${data.vaultId}`,
        html: this.generateVaultCreatedHTML(data),
        text: this.generateVaultCreatedText(data),
      },
      deadline_approaching: {
        subject: `Deadline Approaching for Vault ${data.vaultId}`,
        html: this.generateDeadlineApproachingHTML(data),
        text: this.generateDeadlineApproachingText(data),
      },
      funds_released: {
        subject: `Funds Released from Vault ${data.vaultId}`,
        html: this.generateFundsReleasedHTML(data),
        text: this.generateFundsReleasedText(data),
      },
      funds_redirected: {
        subject: `Funds Redirected from Vault ${data.vaultId}`,
        html: this.generateFundsRedirectedHTML(data),
        text: this.generateFundsRedirectedText(data),
      },
      verification_requested: {
        subject: `Verification Required for Vault ${data.vaultId}`,
        html: this.generateVerificationRequestedHTML(data),
        text: this.generateVerificationRequestedText(data),
      },
    }

    return templates[type as keyof typeof templates] || {
      subject: 'Disciplr Notification',
      html: '<p>You have a new notification from Disciplr.</p>',
      text: 'You have a new notification from Disciplr.',
    }
  }

  private generateVaultCreatedHTML(data: Record<string, any>): string {
    return `
      <h2>Vault Created Successfully</h2>
      <p>Your vault has been created with the following details:</p>
      <ul>
        <li><strong>Vault ID:</strong> ${data.vaultId}</li>
        <li><strong>Amount:</strong> ${data.amount}</li>
        <li><strong>Start Date:</strong> ${new Date(data.startTimestamp).toLocaleDateString()}</li>
        <li><strong>End Date:</strong> ${new Date(data.endTimestamp).toLocaleDateString()}</li>
        <li><strong>Success Destination:</strong> ${data.successDestination}</li>
        <li><strong>Failure Destination:</strong> ${data.failureDestination}</li>
      </ul>
      <p>You can manage your vault through the Disciplr dashboard.</p>
    `
  }

  private generateVaultCreatedText(data: Record<string, any>): string {
    return `
Vault Created Successfully

Your vault has been created with the following details:
- Vault ID: ${data.vaultId}
- Amount: ${data.amount}
- Start Date: ${new Date(data.startTimestamp).toLocaleDateString()}
- End Date: ${new Date(data.endTimestamp).toLocaleDateString()}
- Success Destination: ${data.successDestination}
- Failure Destination: ${data.failureDestination}

You can manage your vault through the Disciplr dashboard.
    `.trim()
  }

  private generateDeadlineApproachingHTML(data: Record<string, any>): string {
    return `
      <h2>Deadline Approaching</h2>
      <p>The deadline for vault <strong>${data.vaultId}</strong> is approaching.</p>
      <ul>
        <li><strong>Time Remaining:</strong> ${data.timeRemaining}</li>
        <li><strong>Amount:</strong> ${data.amount}</li>
        <li><strong>End Date:</strong> ${new Date(data.endTimestamp).toLocaleDateString()}</li>
      </ul>
      <p>Please ensure all necessary actions are taken before the deadline.</p>
    `
  }

  private generateDeadlineApproachingText(data: Record<string, any>): string {
    return `
Deadline Approaching

The deadline for vault ${data.vaultId} is approaching.
- Time Remaining: ${data.timeRemaining}
- Amount: ${data.amount}
- End Date: ${new Date(data.endTimestamp).toLocaleDateString()}

Please ensure all necessary actions are taken before the deadline.
    `.trim()
  }

  private generateFundsReleasedHTML(data: Record<string, any>): string {
    return `
      <h2>Funds Released</h2>
      <p>Funds have been successfully released from vault <strong>${data.vaultId}</strong>.</p>
      <ul>
        <li><strong>Amount:</strong> ${data.amount}</li>
        <li><strong>Destination:</strong> ${data.destination}</li>
        <li><strong>Transaction ID:</strong> ${data.transactionId}</li>
        <li><strong>Release Date:</strong> ${new Date(data.releaseDate).toLocaleDateString()}</li>
      </ul>
      <p>You can view the transaction details in your Disciplr dashboard.</p>
    `
  }

  private generateFundsReleasedText(data: Record<string, any>): string {
    return `
Funds Released

Funds have been successfully released from vault ${data.vaultId}.
- Amount: ${data.amount}
- Destination: ${data.destination}
- Transaction ID: ${data.transactionId}
- Release Date: ${new Date(data.releaseDate).toLocaleDateString()}

You can view the transaction details in your Disciplr dashboard.
    `.trim()
  }

  private generateFundsRedirectedHTML(data: Record<string, any>): string {
    return `
      <h2>Funds Redirected</h2>
      <p>Funds from vault <strong>${data.vaultId}</strong> have been redirected.</p>
      <ul>
        <li><strong>Amount:</strong> ${data.amount}</li>
        <li><strong>Original Destination:</strong> ${data.originalDestination}</li>
        <li><strong>New Destination:</strong> ${data.newDestination}</li>
        <li><strong>Reason:</strong> ${data.reason}</li>
        <li><strong>Transaction ID:</strong> ${data.transactionId}</li>
      </ul>
      <p>You can view the transaction details in your Disciplr dashboard.</p>
    `
  }

  private generateFundsRedirectedText(data: Record<string, any>): string {
    return `
Funds Redirected

Funds from vault ${data.vaultId} have been redirected.
- Amount: ${data.amount}
- Original Destination: ${data.originalDestination}
- New Destination: ${data.newDestination}
- Reason: ${data.reason}
- Transaction ID: ${data.transactionId}

You can view the transaction details in your Disciplr dashboard.
    `.trim()
  }

  private generateVerificationRequestedHTML(data: Record<string, any>): string {
    return `
      <h2>Verification Required</h2>
      <p>Verification is required for vault <strong>${data.vaultId}</strong>.</p>
      <ul>
        <li><strong>Verification Type:</strong> ${data.verificationType}</li>
        <li><strong>Requested By:</strong> ${data.requestedBy}</li>
        <li><strong>Request Date:</strong> ${new Date(data.requestDate).toLocaleDateString()}</li>
        <li><strong>Deadline:</strong> ${new Date(data.deadline).toLocaleDateString()}</li>
      </ul>
      <p>Please complete the verification process through your Disciplr dashboard.</p>
    `
  }

  private generateVerificationRequestedText(data: Record<string, any>): string {
    return `
Verification Required

Verification is required for vault ${data.vaultId}.
- Verification Type: ${data.verificationType}
- Requested By: ${data.requestedBy}
- Request Date: ${new Date(data.requestDate).toLocaleDateString()}
- Deadline: ${new Date(data.deadline).toLocaleDateString()}

Please complete the verification process through your Disciplr dashboard.
    `.trim()
  }
}
