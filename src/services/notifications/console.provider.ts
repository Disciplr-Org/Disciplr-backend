import { NotificationProvider } from './provider.js'

export class ConsoleNotificationProvider implements NotificationProvider {
  readonly name = 'console'

  async send(recipient: string, subject: string, body: string): Promise<void> {
    console.log('--- NOTIFICATION ---')
    console.log(`To: ${recipient}`)
    console.log(`Subject: ${subject}`)
    console.log(`Body: ${body}`)
    console.log('--------------------')
  }
}
