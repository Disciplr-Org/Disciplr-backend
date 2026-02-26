export interface EmailProvider {
  sendEmail(params: EmailParams): Promise<EmailResult>
}

export interface EmailParams {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  from?: string
  templateData?: Record<string, any>
}

export interface EmailResult {
  success: boolean
  messageId?: string
  error?: string
}

export interface EmailTemplate {
  name: string
  subject: string
  htmlTemplate: string
  textTemplate?: string
}

export interface EmailConfig {
  provider: 'ses' | 'sendgrid' | 'postmark'
  fromEmail: string
  fromName?: string
  credentials: {
    ses?: {
      region: string
      accessKeyId: string
      secretAccessKey: string
    }
    sendgrid?: {
      apiKey: string
    }
    postmark?: {
      serverToken: string
    }
  }
}

export type EmailEventType = 
  | 'vault_created'
  | 'deadline_approaching'
  | 'funds_released'
  | 'funds_redirected'
  | 'verification_requested'

export interface EmailEventPayload {
  type: EmailEventType
  recipient: string
  data: Record<string, any>
}
