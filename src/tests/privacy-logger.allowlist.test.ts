import { test, expect, describe } from 'bun:test'
import { redact, REDACTED } from '../middleware/privacy-logger'

describe('privacy-logger allowlist mode', () => {
  test('unknown secret field is redacted', () => {
    const input = { newlyAddedSecret: 'super-secret', otherUnknown: 123 }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      newlyAddedSecret: REDACTED,
      otherUnknown: REDACTED,
    })
  })

  test('nested secret is redacted', () => {
    const input = { data: { someSecret: 'hidden' } }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      data: {
        someSecret: REDACTED,
      },
    })
  })

  test('allowlisted field passes', () => {
    const input = { requestId: '12345', status: 200 }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      requestId: '12345',
      status: 200,
    })
  })

  test('denylist still applies', () => {
    const input = { password: 'secret', status: 200 }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      password: REDACTED,
      status: 200,
    })
  })
})
