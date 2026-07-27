import { sanitizeReasonText } from '../routes/admin.js'

describe('sanitizeReasonText combined-PII redaction', () => {
  it('redacts email, token, IP, card and SSN when present together', () => {
    const input = 'Email: alice@example.com token: abcdefghijklmnopqrstuvwxyzABCDEFG12345678 IP: 192.168.0.1 card: 4111-1111-1111-1111 SSN: 123-45-6789'
    const out = sanitizeReasonText(input)

    expect(out).toBe(
      'Email: [REDACTED_EMAIL] token: [REDACTED_TOKEN] IP: [REDACTED_IP] card: [REDACTED_CARD] SSN: [REDACTED_SSN]'
    )
  })
})
