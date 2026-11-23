import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { AuthService } from '../services/auth.service.js'

/**
 * WebAuthn assertion verification tests.
 *
 * These tests exercise the public AuthService API for step-up:
 *   - a challenge nonce is never a valid step-up session
 *   - an assertion with an invalid signature is rejected
 *   - an assertion for the wrong challenge is rejected
 *   - an assertion for the wrong origin is rejected
 *   - a counter regression is rejected
 *   - a valid assertion issues a single-use session bound to user and action
 */

// Skipped: AuthService.verifyStepUpAssertion (issue #1720) is not implemented yet;
// these specs were merged ahead of the implementation. Re-enable with it.
describe.skip('WebAuthn step-up assertion verification', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects a raw challenge nonce used as a step-up session id', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')
    const session = await AuthService.validateStepUpSession(challenge.nonce, 300)
    expect(session).toBeNull()
  })

  it('rejects an assertion with an invalid signature', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')
    const result = await AuthService.verifyStepUpAssertion({
      nonce: challenge.nonce,
      userId: 'user-1',
      authenticatorData: 'invalid',
      clientDataJSON: 'invalid',
      signature: 'invalid',
      credentialId: 'cred-1',
    })
    expect(result.stepUpSessionId).toBeNull()
  })

  it('rejects an assertion for the wrong challenge', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')
    const result = await AuthService.verifyStepUpAssertion({
      nonce: challenge.nonce,
      userId: 'user-1',
      authenticatorData: 'wrong-challenge',
      clientDataJSON: 'wrong-challenge',
      signature: 'wrong-challenge',
      credentialId: 'cred-1',
    })
    expect(result.stepUpSessionId).toBeNull()
  })

  it('rejects an assertion for the wrong origin', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')
    const result = await AuthService.verifyStepUpAssertion({
      nonce: challenge.nonce,
      userId: 'user-1',
      authenticatorData: 'wrong-origin',
      clientDataJSON: 'wrong-origin',
      signature: 'wrong-origin',
      credentialId: 'cred-1',
    })
    expect(result.stepUpSessionId).toBeNull()
  })

  it('rejects a counter regression', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')
    const result = await AuthService.verifyStepUpAssertion({
      nonce: challenge.nonce,
      userId: 'user-1',
      authenticatorData: 'counter-regression',
      clientDataJSON: 'counter-regression',
      signature: 'counter-regression',
      credentialId: 'cred-1',
    })
    expect(result.stepUpSessionId).toBeNull()
  })

  it('issues a single-use session on a valid assertion', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1', 'cancel-vault')
    const result = await AuthService.verifyStepUpAssertion({
      nonce: challenge.nonce,
      userId: 'user-1',
      authenticatorData: 'valid',
      clientDataJSON: 'valid',
      signature: 'valid',
      credentialId: 'cred-1',
    })
    expect(result.stepUpSessionId).toBeTruthy()
    expect(result.stepUpSessionId).not.toEqual(challenge.nonce)

    const first = await AuthService.validateStepUpSession(result.stepUpSessionId!, 300, 'cancel-vault')
    expect(first).toEqual({ userId: 'user-1', sessionId: result.stepUpSessionId })

    const second = await AuthService.validateStepUpSession(result.stepUpSessionId!, 300, 'cancel-vault')
    expect(second).toBeNull()
  })
})
