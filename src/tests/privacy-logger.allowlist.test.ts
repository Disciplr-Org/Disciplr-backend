import { describe, it, expect } from '@jest/globals'
import { redact, REDACTED } from '../middleware/privacy-logger.js'

describe('privacy-logger allowlist mode', () => {
  it('unknown secret field is redacted', () => {
    const input = { newlyAddedSecret: 'super-secret', otherUnknown: 123 }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      newlyAddedSecret: REDACTED,
      otherUnknown: REDACTED,
    })
  })

  it('nested secret is redacted', () => {
    const input = { data: { someSecret: 'hidden' } }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      data: REDACTED,
    })
  })

  it('allowlisted field passes', () => {
    const input = { requestId: '12345', status: 200 }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      requestId: '12345',
      status: 200,
    })
  })

  it('denylist still applies', () => {
    const input = { password: 'secret', status: 200 }
    const result = redact(input, undefined, true)
    expect(result).toEqual({
      password: REDACTED,
      status: 200,
    })
  })
})
