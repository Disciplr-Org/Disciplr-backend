import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import {
  buildEmailMessage,
  EmailNotificationProvider,
} from '../services/notifications/email.provider.js'

describe('EmailNotificationProvider injection guards', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('strips CRLF from recipient and subject headers', () => {
    const message = buildEmailMessage(
      'user@example.com\r\nBcc: attacker@example.com',
      'Vault update\r\nX-Injected: yes',
      'Milestone approved',
    )

    expect(message.recipient).toBe('user@example.com Bcc: attacker@example.com')
    expect(message.subject).toBe('Vault update X-Injected: yes')
    expect(message.recipient).not.toMatch(/[\r\n]/)
    expect(message.subject).not.toMatch(/[\r\n]/)
  })

  it('escapes dynamic HTML body content', () => {
    const message = buildEmailMessage(
      'user@example.com',
      'Vault update',
      'Org <script>alert("x")</script> & <b>Vault</b>',
    )

    expect(message.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(message.html).toContain('&lt;b&gt;Vault&lt;/b&gt;')
    expect(message.html).toContain('&amp;')
    expect(message.html).not.toContain('<script>')
    expect(message.html).not.toContain('<b>Vault</b>')
  })

  it('preserves benign text and HTML rendering', () => {
    const message = buildEmailMessage(
      'member@example.com',
      'Milestone approved',
      'Milestone 1 approved',
    )

    expect(message.recipient).toBe('member@example.com')
    expect(message.subject).toBe('Milestone approved')
    expect(message.text).toBe('Milestone 1 approved')
    expect(message.html).toBe('Milestone 1 approved')
  })

  it('passes sanitized fields to the provider send implementation', async () => {
    const provider = new EmailNotificationProvider()
    const performSend = jest.fn<any>().mockResolvedValue(undefined)
    ;(provider as any).performSend = performSend

    await provider.send(
      'member@example.com\r\nCc: attacker@example.com',
      'Vault <ready>\nInjected: yes',
      'Org <ACME> is ready',
    )

    expect(performSend).toHaveBeenCalledTimes(1)
    const [message] = performSend.mock.calls[0]
    expect(message.recipient).toBe('member@example.com Cc: attacker@example.com')
    expect(message.subject).toBe('Vault <ready> Injected: yes')
    expect(message.html).toContain('Org &lt;ACME&gt; is ready')
    expect(`${message.recipient}${message.subject}`).not.toMatch(/[\r\n]/)
  })
})
