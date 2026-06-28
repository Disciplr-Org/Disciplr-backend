import { describe, it, expect, jest } from '@jest/globals'
import { NotificationService } from '../services/notifications/factory.js'
import type { NotificationProvider } from '../services/notifications/provider.js'

describe('NotificationService factory behavior', () => {
  const createStubProvider = (name: string): NotificationProvider => ({
    name,
    send: jest.fn<any>().mockResolvedValue(undefined),
  })

  it('throws at initialization when the default provider is unknown', () => {
    expect(() => {
      new NotificationService({ console: createStubProvider('console') }, 'email')
    }).toThrow('Unknown default notification provider "email"')
  })

  it('throws when requesting an unknown provider override', async () => {
    const service = new NotificationService({ console: createStubProvider('console') }, 'console')

    await expect(service.send('user@example.com', 'subject', 'body', 'email')).rejects.toThrow(
      'Unknown notification provider "email"',
    )
  })
})
