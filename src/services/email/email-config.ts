import type { EmailConfig } from '../../types/email.js'

export function getEmailConfig(): EmailConfig {
  const provider = (process.env.EMAIL_PROVIDER || 'ses').toLowerCase() as 'ses' | 'sendgrid' | 'postmark'
  const fromEmail = process.env.EMAIL_FROM || 'noreply@disciplr.com'
  const fromName = process.env.EMAIL_FROM_NAME || 'Disciplr'

  if (!fromEmail) {
    throw new Error('EMAIL_FROM environment variable is required')
  }

  const config: EmailConfig = {
    provider,
    fromEmail,
    fromName,
    credentials: {},
  }

  switch (provider) {
    case 'ses':
      config.credentials.ses = {
        region: process.env.AWS_REGION || 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      }
      
      if (!config.credentials.ses.accessKeyId || !config.credentials.ses.secretAccessKey) {
        throw new Error('AWS credentials are required for SES provider')
      }
      break

    case 'sendgrid':
      config.credentials.sendgrid = {
        apiKey: process.env.SENDGRID_API_KEY || '',
      }
      
      if (!config.credentials.sendgrid.apiKey) {
        throw new Error('SENDGRID_API_KEY environment variable is required')
      }
      break

    case 'postmark':
      config.credentials.postmark = {
        serverToken: process.env.POSTMARK_SERVER_TOKEN || '',
      }
      
      if (!config.credentials.postmark.serverToken) {
        throw new Error('POSTMARK_SERVER_TOKEN environment variable is required')
      }
      break

    default:
      throw new Error(`Unsupported email provider: ${provider}`)
  }

  return config
}

export function validateEmailConfig(): boolean {
  try {
    getEmailConfig()
    return true
  } catch (error) {
    console.error('Email configuration validation failed:', error)
    return false
  }
}
