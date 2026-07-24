import { NotificationProvider } from './provider.js'
import { EmailNotificationProvider } from './email.provider.js'
import { ConsoleNotificationProvider } from './console.provider.js'

export class NotificationService {
  constructor(
    private readonly providers: Record<string, NotificationProvider>,
    private readonly defaultProviderName: string,
  ) {
    this.assertProviderExists(defaultProviderName)
  }

  getProvider(name?: string): NotificationProvider {
    const providerName = name ?? this.defaultProviderName
    const provider = this.providers[providerName]

    if (!provider) {
      const availableProviders = Object.keys(this.providers).sort().join(', ')
      throw new Error(
        `Unknown notification provider "${providerName}". Available providers: ${availableProviders}`,
      )
    }

    return provider
  }

  async send(
    recipient: string,
    subject: string,
    body: string,
    providerName?: string,
  ): Promise<void> {
    const provider = this.getProvider(providerName)
    await provider.send(recipient, subject, body)
  }

  private assertProviderExists(providerName: string): void {
    if (!this.providers[providerName]) {
      const availableProviders = Object.keys(this.providers).sort().join(', ')
      throw new Error(
        `Unknown default notification provider "${providerName}". Available providers: ${availableProviders}`,
      )
    }
  }
}

export const buildNotificationProviderRegistry = (): Record<string, NotificationProvider> => ({
  email: new EmailNotificationProvider(),
  console: new ConsoleNotificationProvider(),
})

export const createNotificationService = (
  defaultProviderName: string,
  providers: Record<string, NotificationProvider> = buildNotificationProviderRegistry(),
): NotificationService => {
  return new NotificationService(providers, defaultProviderName)
}
