import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../services/auth.service.js', () => ({
  AuthService: {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
    issueStepUpChallenge: vi.fn(),
    recordStepUpAssertion: vi.fn(),
    registerWebAuthnCredential: vi.fn(),
  },
}))

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../lib/audit-logs.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue({ id: 'audit-log-id' }),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticate: vi.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'ADMIN', jmti: 'jmti-1' }
    next()
  }),
}))

vi.mock('../middleware/stepUp.js', () => ({
  requireStepUp: vi.fn().mockReturnValue((req: any, _res: any, next: any) => next()),
}))

vi.mock('../services/session.js', () => ({
  revokeSession: vi.fn().mockResolvedValue(undefined),
  revokeAllUserSessions: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../middleware/rateLimiter.js', () => ({
  authRateLimiter: vi.fn((req: any, _res: any, next: any) => next()),
 }))

import { authRouter } from './auth.js'
import { AuthService } from '../services/auth.service.js'
import { prisma } from '../lib/prisma.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { revokeSession, revokeAllUserSessions } from '../services/session.js'
import { authenticate } from '../middleware/auth.js'
