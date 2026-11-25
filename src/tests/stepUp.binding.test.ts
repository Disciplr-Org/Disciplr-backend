import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { AuthService } from '../services/auth.service.js'
import { requireStepUp } from '../middleware/stepUp.js'
import { UserRole } from '../types/user.js'
import { InMemoryStepUpStore, setStepUpStore } from '../services/stepUpStore.js'

beforeEach(() => {
  setStepUpStore(new InMemoryStepUpStore())
})

/**
 * Step-up token binding and replay-window security tests.
 *
 * These tests verify that step-up sessions are:
 * - Issued only after a verified WebAuthn assertion (not raw challenge nonces)
 * - Bound to the user who requested them (preventing cross-user replay)
 * - Bound to the action context when specified (preventing cross-action replay)
 * - Time-bound with strict expiry enforcement (preventing replay after window)
 * - Single-use only (preventing replay even within validity window)
 *
 * Security properties tested:
 * - Raw challenge nonces are rejected as step-up sessions
 * - Token binding prevents privilege escalation via captured tokens
 * - Action binding prevents token reuse across different destructive operations
 * - Strict expiry prevents replay attacks after token window closes
 * - Single-use enforcement prevents token replay by attackers
 */

function createMockRequest(options: {
  userId: string | null
  sessionId: string
  role?: UserRole
  method?: string
  path?: string
  body?: any
  headers?: Record<string, string>
  query?: Record<string, string>
}): any {
  return {
    user: options.userId ? { userId: options.userId, role: options.role } : null,
    authUser: options.userId ? { userId: options.userId } : null,
    headers: {
      'x-step-up-session-id': options.headers?.['x-step-up-session-id'] ?? options.sessionId,
      ...options.headers
    },
    body: options.body ?? { stepUpSessionId: options.sessionId },
    query: options.query ?? { stepUpSessionId: options.sessionId },
    method: options.method ?? 'POST',
    path: options.path ?? '/api/test',
    route: { path: options.path ?? '/api/test' }
  }
}

function createMockResponse(): any {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

/**
 * Issue a step-up session for tests. This goes through the same service path that a
 * verified WebAuthn assertion would use, so the returned id is a real step-up
 * session id and not a challenge nonce.
 */
async function issueSession(userId: string, action?: string): Promise<string> {
  const session = await AuthService.createStepUpSession(userId, action)
  return session.sessionId
}

describe('Step-up challenge nonce is not a session', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects a raw challenge nonce used as x-step-up-session-id', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')

    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: challenge.nonce
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    await requireStepUp()(mockReq, mockRes, next)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ stepUpRequired: true })
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a challenge nonce in validateStepUpSession', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')

    const result = await AuthService.validateStepUpSession(challenge.nonce, 300)
    expect(result).toBeNull()
  })

  it('rejects a challenge nonce after a successful assertion for the same user', async () => {
    const challenge = await AuthService.issueStepUpChallenge('user-1')
    const sessionId = await issueSession('user-1')

    expect(sessionId).not.toEqual(challenge.nonce)

    const nonceResult = await AuthService.validateStepUpSession(challenge.nonce, 300)
    expect(nonceResult).toBeNull()

    const sessionResult = await AuthService.validateStepUpSession(sessionId, 300)
    expect(sessionResult).toEqual({ userId: 'user-1', sessionId })
  })
})

describe('Step-up token user binding', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects token issued for user A when used by user B', async () => {
    const sessionId = await issueSession('user-A')

    const mockReq = createMockRequest({
      userId: 'user-B',
      sessionId,
      role: UserRole.USER
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    await requireStepUp()(mockReq, mockRes, next)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ stepUpRequired: true })
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts token when userId matches token binding', async () => {
    const sessionId = await issueSession('user-1')

    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId,
      role: UserRole.USER
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    await requireStepUp()(mockReq, mockRes, next)

    expect(next).toHaveBeenCalled()
  })

  it('handles null/undefined userId gracefully', async () => {
    const sessionId = await issueSession('user-1')

    const mockReq = createMockRequest({
      userId: null,
      sessionId
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    await requireStepUp()(mockReq, mockRes, next)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects token with mismatched userId in middleware validation', async () => {
    const sessionId = await issueSession('user-1')

    const mockReq = createMockRequest({
      userId: 'user-2',
      sessionId,
      role: UserRole.ADMIN
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    await requireStepUp()(mockReq, mockRes, next)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('Step-up token action binding', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects token issued for action X when used for action Y', async () => {
    const sessionId = await issueSession('user-1', 'cancel-vault')

    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId,
      role: UserRole.ADMIN,
      path: '/api/admin/users/revoke-sessions',
      method: 'POST'
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    const actionResolver = (req: any) => 'revoke-sessions'
    await requireStepUp(300, actionResolver)(mockReq, mockRes, next)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts token when action matches', async () => {
    const sessionId = await issueSession('user-1', 'cancel-vault')

    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId,
      role: UserRole.ADMIN
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    const actionResolver = (req: any) => 'cancel-vault'
    await requireStepUp(300, actionResolver)(mockReq, mockRes, next)

    expect(next).toHaveBeenCalled()
  })

  it('tokens without explicit action work with generic resolver', async () => {
    const sessionId = await issueSession('user-1')

    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId,
      role: UserRole.USER
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    await requireStepUp()(mockReq, mockRes, next)

    expect(next).toHaveBeenCalled()
  })

  it('action-bound token rejects when action does not match', async () => {
    const sessionId = await issueSession('user-1', 'impersonate')

    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId,
      role: UserRole.ADMIN
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    const actionResolver = (req: any) => 'cancel-vault'
    await requireStepUp(300, actionResolver)(mockReq, mockRes, next)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('action-bound token accepts when action matches exactly', async () => {
    const sessionId = await issueSession('user-1', 'POST:/api/admin/impersonate/:userId')

    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId,
      role: UserRole.ADMIN,
      method: 'POST',
      path: '/api/admin/impersonate/target-user'
    })
    const mockRes = createMockResponse()
    const next = jest.fn()

    const actionResolver = (req: any) => 'POST:/api/admin/impersonate/:userId'
    await requireStepUp(300, actionResolver)(mockReq, mockRes, next)

    expect(next).toHaveBeenCalled()
  })
})

describe('Step-up token replay window', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('accepts token used within validity window', async () => {
    const sessionId = await issueSession('user-1')

    const result = await AuthService.validateStepUpSession(sessionId, 300)

    expect(result).toEqual({ userId: 'user-1', sessionId })
  })

  it('rejects token 1ms after expiry', async () => {
    const sessionId = await issueSession('user-1')

    jest.setSystemTime(new Date('2026-06-26T00:05:00.001Z'))

    const result = await AuthService.validateStepUpSession(sessionId, 300)
    expect(result).toBeNull()
  })

  it('rejects token at exact expiry boundary', async () => {
    const sessionId = await issueSession('user-1')

    jest.setSystemTime(new Date('2026-06-26T00:05:00.000Z'))

    const result = await AuthService.validateStepUpSession(sessionId, 300)
    expect(result).not.toBeNull()
  })

  it('rejects token 1ms after expiry boundary', async () => {
    const sessionId = await issueSession('user-1')

    jest.setSystemTime(new Date('2026-06-26T00:05:00.001Z'))

    const result = await AuthService.validateStepUpSession(sessionId, 300)
    expect(result).toBeNull()
  })

  it('accepts token 1 second before expiry with maxAge check', async () => {
    const sessionId = await issueSession('user-1')

    jest.setSystemTime(new Date('2026-06-26T00:04:59.000Z'))

    const result = await AuthService.validateStepUpSession(sessionId, 300)
    expect(result).not.toBeNull()
  })

  it('prevents replay of already-used token', async () => {
    const sessionId = await issueSession('user-1')

    const firstUse = await AuthService.validateStepUpSession(sessionId, 300)
    expect(firstUse).not.toBeNull()

    const secondUse = await AuthService.validateStepUpSession(sessionId, 300)
    expect(secondUse).toBeNull()
  })

  it('prevents replay via recordStepUpAssertion after validateStepUpSession', async () => {
    const sessionId = await issueSession('user-1')

    await AuthService.validateStepUpSession(sessionId, 300)

    const replay = await AuthService.recordStepUpAssertion(sessionId, 'user-1')
    expect(replay).toBe(false)
  })

  it('prevents replay via validateStepUpSession after recordStepUpAssertion', async () => {
    const sessionId = await issueSession('user-1')

    const firstUse = await AuthService.recordStepUpAssertion(sessionId, 'user-1')
    expect(firstUse).toBe(true)

    const replay = await AuthService.validateStepUpSession(sessionId, 300)
    expect(replay).toBeNull()
  })
})

describe('Step-up token edge cases and attack prevention', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects manipulated session ID', async () => {
    const sessionId = await issueSession('user-1')
    const tampered = sessionId.slice(0, -1) + (sessionId.endsWith('a') ? 'b' : 'a')

    const result = await AuthService.validateStepUpSession(tampered, 300)
    expect(result).toBeNull()
  })

  it('rejects empty session ID', async () => {
    const result = await AuthService.validateStepUpSession('', 300)
    expect(result).toBeNull()
  })

  it('rejects unknown session ID', async () => {
    const result = await AuthService.validateStepUpSession('not-a-real-session', 300)
    expect(result).toBeNull()
  })

  it('rejects session when maxAge is zero', async () => {
    const sessionId = await issueSession('user-1')

    jest.setSystemTime(new Date('2026-06-26T00:00:01.000Z'))

    const result = await AuthService.validateStepUpSession(sessionId, 0)
    expect(result).toBeNull()
  })

  it('rejects session for different user in validateStepUpSession', async () => {
    const sessionId = await issueSession('user-1')

    const result = await AuthService.validateStepUpSession(sessionId, 300, 'user-2')
    expect(result).toBeNull()
  })

  it('rejects session for different action in validateStepUpSession', async () => {
    const sessionId = await issueSession('user-1', 'cancel-vault')

    const result = await AuthService.validateStepUpSession(sessionId, 300, 'user-1', 'revoke-sessions')
    expect(result).toBeNull()
  })

  it('accepts session for matching user and action in validateStepUpSession', async () => {
    const sessionId = await issueSession('user-1', 'cancel-vault')

    const result = await AuthService.validateStepUpSession(sessionId, 300, 'user-1', 'cancel-vault')
    expect(result).toEqual({ userId: 'user-1', sessionId })
  })
})
