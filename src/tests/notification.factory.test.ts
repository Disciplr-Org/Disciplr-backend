import { describe, it, expect, jest } from '@jest/globals'
import {
  NotificationService,
  createNotificationService,
} from '../services/notifications/factory.js'
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

// ─── End-to-end: NotificationService.send() ───────────────────────────────────
//
// These tests exercise the full path:
//   createNotificationService → NotificationService constructor
//     → send() → getProvider() (instance method, reads this.providers)
//     → provider.send()
//
// Before the bug fix, getProvider was `static`, so this.providers did not
// exist on the static context and every send() call threw a TS2339/TypeError
// at runtime. These tests would have failed with
// "Cannot read properties of undefined (reading '<providerName>')" or
// "this.getProvider is not a function".

describe('NotificationService.send() — end-to-end', () => {
  const makeStub = (name: string): NotificationProvider => ({
    name,
    send: jest.fn<NotificationProvider['send']>().mockResolvedValue(undefined),
  })

  // Helper to extract the Jest mock from a provider's send function.
  const asMock = (p: NotificationProvider) =>
    p.send as jest.MockedFunction<NotificationProvider['send']>

  it('routes to the named provider via createNotificationService', async () => {
    const emailStub = makeStub('email')
    const consoleStub = makeStub('console')
    const service = createNotificationService('console', { email: emailStub, console: consoleStub })

    await service.send('alice@example.com', 'Hello', 'World', 'email')

    expect(asMock(emailStub)).toHaveBeenCalledTimes(1)
    expect(asMock(emailStub)).toHaveBeenCalledWith('alice@example.com', 'Hello', 'World')
    expect(asMock(consoleStub)).not.toHaveBeenCalled()
  })

  it('falls back to the default provider when no override is given', async () => {
    const emailStub = makeStub('email')
    const consoleStub = makeStub('console')
    const service = createNotificationService('console', { email: emailStub, console: consoleStub })

    await service.send('bob@example.com', 'Subject', 'Body')

    expect(asMock(consoleStub)).toHaveBeenCalledTimes(1)
    expect(asMock(consoleStub)).toHaveBeenCalledWith('bob@example.com', 'Subject', 'Body')
    expect(asMock(emailStub)).not.toHaveBeenCalled()
  })

  it('resolves successfully (does not throw) for a valid send call', async () => {
    const consoleStub = makeStub('console')
    const service = createNotificationService('console', { console: consoleStub })

    await expect(
      service.send('carol@example.com', 'Test', 'Test body'),
    ).resolves.toBeUndefined()
  })

  it('propagates errors thrown by the underlying provider', async () => {
    const broken = makeStub('console')
    asMock(broken).mockRejectedValue(new Error('SMTP timeout'))
    const service = createNotificationService('console', { console: broken })

    await expect(
      service.send('dave@example.com', 'Oops', 'Will fail'),
    ).rejects.toThrow('SMTP timeout')
  })

  it('getProvider is an instance method — callable from send() without TypeError', async () => {
    // This is the regression guard: if getProvider were still static,
    // `this.getProvider` would be undefined and send() would throw
    // "this.getProvider is not a function" before even reaching the provider.
    const consoleStub = makeStub('console')
    const service = createNotificationService('console', { console: consoleStub })

    // Must not throw "this.getProvider is not a function"
    await expect(
      service.send('eve@example.com', 'Regression', 'guard'),
    ).resolves.toBeUndefined()

    expect(asMock(consoleStub)).toHaveBeenCalledTimes(1)
  })
})
