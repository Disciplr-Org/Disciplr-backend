import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { AuthService } from '../services/auth.service.js'

describe('AuthService step-up challenge flow', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('issues a challenge, consumes it once, and rejects replays', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')

    expect(challenge.challenge).toBe('webauthn-step-up')
    expect(challenge.ttlSeconds).toBe(300)

    const firstUse = await AuthService.recordStepUpAssertion(challenge.nonce, 'user-1')
    const secondUse = await AuthService.recordStepUpAssertion(challenge.nonce, 'user-1')

    expect(firstUse).toBe(true)
    expect(secondUse).toBe(false)
  })

  it('rejects stale challenges after the maximum age', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-2')

    jest.setSystemTime(new Date('2026-06-26T00:06:00.000Z'))

    const validated = await AuthService.validateStepUpSession(challenge.nonce, 300)
    expect(validated).toBeNull()
  })
})
