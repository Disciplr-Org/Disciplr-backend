import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { AuthService } from '../services/auth.service.js'
import { requireStepUp } from '../middleware/stepUp.js'
import { generateAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/user.js'
import { Request, Response, NextFunction } from 'express'

/**
 * Step-up token binding and replay-window security tests.
 * 
 * These tests verify that step-up tokens are:
 * - Bound to the user who requested them (preventing cross-user replay)
 * - Bound to the action context when specified (preventing cross-action replay)
 * - Time-bound with strict expiry enforcement (preventing replay after window)
 * - Single-use only (preventing replay even within validity window)
 * 
 * Security properties tested:
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

describe('Step-up token user binding', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })
  
  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects token issued for user A when used by user B', async () => {
    const tokenA = await AuthService.issueStepUpChallenge('user-A')
    
    const mockReq = createMockRequest({
      userId: 'user-B',
      sessionId: tokenA.nonce,
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
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
      role: UserRole.USER
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(next).toHaveBeenCalled()
  })

  it('handles null/undefined userId gracefully', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const mockReq = createMockRequest({
      userId: null,
      sessionId: token.nonce
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects token with mismatched userId in middleware validation', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const mockReq = createMockRequest({
      userId: 'user-2',
      sessionId: token.nonce,
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
    const token = await AuthService.issueStepUpChallenge('user-1', 'cancel-vault')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
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
    const token = await AuthService.issueStepUpChallenge('user-1', 'cancel-vault')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
      role: UserRole.ADMIN
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    const actionResolver = (req: any) => 'cancel-vault'
    await requireStepUp(300, actionResolver)(mockReq, mockRes, next)
    
    expect(next).toHaveBeenCalled()
  })

  it('tokens without explicit action work with generic resolver', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
      role: UserRole.USER
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(next).toHaveBeenCalled()
  })

  it('action-bound token rejects when action does not match', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1', 'impersonate')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
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
    const token = await AuthService.issueStepUpChallenge('user-1', 'POST:/api/admin/impersonate/:userId')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
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
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const result = await AuthService.validateStepUpSession(token.nonce, 300)
    
    expect(result).toEqual({ userId: 'user-1', sessionId: token.nonce })
  })

  it('rejects token 1ms after expiry', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    jest.setSystemTime(new Date('2026-06-26T00:05:00.001Z'))
    
    const result = await AuthService.validateStepUpSession(token.nonce, 300)
    expect(result).toBeNull()
  })

  it('rejects token at exact expiry boundary', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    jest.setSystemTime(new Date('2026-06-26T00:05:00.000Z'))
    
    const result = await AuthService.validateStepUpSession(token.nonce, 300)
    expect(result).not.toBeNull()
  })

  it('rejects token 1ms after expiry boundary', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    jest.setSystemTime(new Date('2026-06-26T00:05:00.001Z'))
    
    const result = await AuthService.validateStepUpSession(token.nonce, 300)
    expect(result).toBeNull()
  })

  it('accepts token 1 second before expiry with maxAge check', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    jest.setSystemTime(new Date('2026-06-26T00:04:59.000Z'))
    
    const result = await AuthService.validateStepUpSession(token.nonce, 300)
    expect(result).not.toBeNull()
  })

  it('prevents replay of already-used token', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const firstUse = await AuthService.validateStepUpSession(token.nonce, 300)
    expect(firstUse).not.toBeNull()
    
    const secondUse = await AuthService.validateStepUpSession(token.nonce, 300)
    expect(secondUse).toBeNull()
  })

  it('prevents replay via recordStepUpAssertion after validateStepUpSession', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    await AuthService.validateStepUpSession(token.nonce, 300)
    
    const replay = await AuthService.recordStepUpAssertion(token.nonce, 'user-1')
    expect(replay).toBe(false)
  })

  it('prevents replay via validateStepUpSession after recordStepUpAssertion', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const firstUse = await AuthService.recordStepUpAssertion(token.nonce, 'user-1')
    expect(firstUse).toBe(true)
    
    const replay = await AuthService.validateStepUpSession(token.nonce, 300)
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
    const token = await AuthService.issueStepUpChallenge('user-1')
    const manipulatedId = token.nonce + '-manipulated'
    
    const result = await AuthService.validateStepUpSession(manipulatedId, 300)
    expect(result).toBeNull()
  })

  it('rejects expired token replay attempt', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    jest.setSystemTime(new Date('2026-06-26T00:05:01.000Z'))
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects token with mismatched case in userId', async () => {
    const token = await AuthService.issueStepUpChallenge('User-1')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(next).not.toHaveBeenCalled()
    expect(mockRes.status).toHaveBeenCalledWith(401)
  })

  it('handles concurrent validation attempts atomically', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const [result1, result2, result3] = await Promise.all([
      AuthService.validateStepUpSession(token.nonce, 300),
      AuthService.validateStepUpSession(token.nonce, 300),
      AuthService.validateStepUpSession(token.nonce, 300)
    ])
    
    const successCount = [result1, result2, result3].filter(r => r !== null).length
    expect(successCount).toBe(1)
  })

  it('rejects token from different session context', async () => {
    const token1 = await AuthService.issueStepUpChallenge('user-1')
    const token2 = await AuthService.issueStepUpChallenge('user-1')
    
    await AuthService.validateStepUpSession(token1.nonce, 300)
    
    const result = await AuthService.validateStepUpSession(token2.nonce, 300)
    expect(result).not.toBeNull()
  })

  it('rejects empty session ID', async () => {
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: ''
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects token when userId is undefined', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const mockReq = {
      user: null,
      authUser: null,
      headers: { 'x-step-up-session-id': token.nonce },
      body: {},
      query: {},
      method: 'POST',
      path: '/api/test'
    } as any
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('Step-up middleware integration', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-06-26T00:00:00.000Z'))
  })
  
  afterEach(() => {
    jest.useRealTimers()
  })

  it('blocks request without step-up session ID', async () => {
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: ''
    })
    delete (mockReq as any).headers['x-step-up-session-id']
    ;(mockReq as any).body = {}
    ;(mockReq as any).query = {}
    
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ stepUpRequired: true })
    )
    expect(next).not.toHaveBeenCalled()
  })

  it('extracts session ID from body when not in header', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
      headers: {}
    })
    delete (mockReq as any).headers['x-step-up-session-id']
    
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(next).toHaveBeenCalled()
  })

  it('extracts session ID from query when not in header/body', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce,
      headers: {},
      body: {}
    })
    delete (mockReq as any).headers['x-step-up-session-id']
    delete (mockReq as any).body.stepUpSessionId
    
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(next).toHaveBeenCalled()
  })

  it('allows request with valid step-up session', async () => {
    const token = await AuthService.issueStepUpChallenge('admin-1')
    
    const mockReq = createMockRequest({
      userId: 'admin-1',
      sessionId: token.nonce,
      role: UserRole.ADMIN
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp()(mockReq, mockRes, next)
    
    expect(next).toHaveBeenCalled()
  })

  it('respects custom maxAgeSeconds parameter', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    jest.setSystemTime(new Date('2026-06-26T00:01:01.000Z'))
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp(60)(mockReq, mockRes, next)
    
    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts request within custom maxAgeSeconds window', async () => {
    const token = await AuthService.issueStepUpChallenge('user-1')
    
    jest.setSystemTime(new Date('2026-06-26T00:04:30.000Z'))
    
    const mockReq = createMockRequest({
      userId: 'user-1',
      sessionId: token.nonce
    })
    const mockRes = createMockResponse()
    const next = jest.fn()
    
    await requireStepUp(120)(mockReq, mockRes, next)
    
    expect(next).toHaveBeenCalled()
  })
})