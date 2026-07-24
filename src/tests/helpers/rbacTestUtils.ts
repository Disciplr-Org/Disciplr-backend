import jwt from 'jsonwebtoken'
import { UserRole } from '../../types/user.js'
import { Response } from 'supertest'

/**
 * RBAC Test Utilities
 * 
 * Provides standardized token generation, security bypass test cases,
 * and validation utilities for comprehensive RBAC testing.
 */

// JWT Secret handling - matches production authentication
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || "change-me-in-production"

export { UserRole }

/**
 * Token Generation Options
 */
export interface TokenGenerationOptions {
  userId?: string
  role: UserRole
  expiresIn?: string
  jti?: string
  email?: string
}

/**
 * Security Bypass Test Case
 */
export interface SecurityBypassTestCase {
  description: string
  headers: Record<string, string>
  expectedStatus: 401 | 403
  expectedErrorPattern: RegExp
}

/**
 * Endpoint Test Case
 */
export interface EndpointTestCase {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  allowedRoles: UserRole[]
  body?: object
  expectedSuccessStatus?: number[]
}

/**
 * Generate valid JWT token for testing
 */
export function generateValidToken(options: TokenGenerationOptions): string {
  const payload = {
    userId: options.userId || 'test-user',
    role: options.role,
    email: options.email || 'test@example.com',
    ...(options.jti && { jti: options.jti })
  }
  
  return jwt.sign(payload, JWT_SECRET, { 
    expiresIn: options.expiresIn || '1h' 
  } as jwt.SignOptions)
}

/**
 * Generate invalid tokens for negative testing
 */
export function generateInvalidToken(type: 'malformed' | 'expired' | 'wrong-secret'): string {
  switch (type) {
    case 'malformed':
      return 'invalid.malformed.token'
    
    case 'expired':
      return jwt.sign(
        { userId: 'test-user', role: UserRole.USER },
        JWT_SECRET,
        { expiresIn: '-1h' } // Expired 1 hour ago
      )
    
    case 'wrong-secret':
      return jwt.sign(
        { userId: 'test-user', role: UserRole.USER },
        'wrong-secret-key'
      )
    
    default:
      throw new Error(`Unknown invalid token type: ${type}`)
  }
}

/**
 * Create security bypass test cases for an endpoint
 */
export function createSecurityBypassTests(endpoint: string): SecurityBypassTestCase[] {
  return [
    {
      description: 'x-user-role header spoofing',
      headers: { 'x-user-role': 'ADMIN' },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    },
    {
      description: 'x-requested-role header spoofing',
      headers: { 'x-requested-role': 'ADMIN' },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    },
    {
      description: 'role header spoofing',
      headers: { 'role': 'ADMIN' },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    },
    {
      description: 'x-auth-role header spoofing',
      headers: { 'x-auth-role': 'ADMIN' },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    },
    {
      description: 'authorization-role header spoofing',
      headers: { 'authorization-role': 'ADMIN' },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    },
    {
      description: 'multiple role headers spoofing',
      headers: {
        'x-user-role': 'ADMIN',
        'x-requested-role': 'ADMIN',
        'role': 'ADMIN'
      },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    },
    {
      description: 'case variation role spoofing',
      headers: { 'x-user-role': 'admin' },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    },
    {
      description: 'superuser role spoofing',
      headers: { 'x-user-role': 'SUPERUSER' },
      expectedStatus: 403,
      expectedErrorPattern: /forbidden/i
    }
  ]
}

/**
 * Standardized test tokens for all roles
 */
export const TEST_TOKENS = {
  user: (userId = 'test-user') => generateValidToken({ 
    userId, 
    role: UserRole.USER 
  }),
  
  verifier: (userId = 'test-verifier') => generateValidToken({ 
    userId, 
    role: UserRole.VERIFIER 
  }),
  
  admin: (userId = 'test-admin') => generateValidToken({ 
    userId, 
    role: UserRole.ADMIN 
  })
}

/**
 * Invalid tokens for negative testing
 */
export const INVALID_TOKENS = {
  malformed: () => generateInvalidToken('malformed'),
  expired: () => generateInvalidToken('expired'),
  wrongSecret: () => generateInvalidToken('wrong-secret'),
  empty: () => '',
  null: () => null as any,
  undefined: () => undefined as any
}

/**
 * Admin endpoints discovered during reconnaissance
 */
export const ADMIN_ENDPOINTS: EndpointTestCase[] = [
  {
    method: 'GET',
    path: '/api/admin/users',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404]
  },
  {
    method: 'PATCH',
    path: '/api/admin/users/:id/role',
    allowedRoles: [UserRole.ADMIN],
    body: { role: 'USER' },
    expectedSuccessStatus: [200, 404, 400]
  },
  {
    method: 'PATCH',
    path: '/api/admin/users/:id/status',
    allowedRoles: [UserRole.ADMIN],
    body: { status: 'ACTIVE' },
    expectedSuccessStatus: [200, 404, 400]
  },
  {
    method: 'DELETE',
    path: '/api/admin/users/:id',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404, 400]
  },
  {
    method: 'POST',
    path: '/api/admin/users/:id/restore',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404, 400]
  },
  {
    method: 'GET',
    path: '/api/admin/audit-logs',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404]
  },
  {
    method: 'GET',
    path: '/api/admin/audit-logs/:id',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404]
  },
  {
    method: 'POST',
    path: '/api/admin/overrides/vaults/:id/cancel',
    allowedRoles: [UserRole.ADMIN],
    body: { reason: 'Test cancellation' },
    expectedSuccessStatus: [200, 404, 409]
  },
  {
    method: 'POST',
    path: '/api/admin/users/:userId/revoke-sessions',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404, 400]
  }
]

/**
 * Verifier endpoints discovered during reconnaissance
 */
export const VERIFIER_ENDPOINTS: EndpointTestCase[] = [
  {
    method: 'POST',
    path: '/api/verifications',
    allowedRoles: [UserRole.VERIFIER, UserRole.ADMIN],
    body: { milestoneId: 'test-milestone' },
    expectedSuccessStatus: [201, 404, 400]
  },
  {
    method: 'GET',
    path: '/api/verifications',
    allowedRoles: [UserRole.ADMIN], // Admin-only for audit purposes
    expectedSuccessStatus: [200, 404]
  }
]

/**
 * Admin verifier management endpoints
 */
export const ADMIN_VERIFIER_ENDPOINTS: EndpointTestCase[] = [
  {
    method: 'GET',
    path: '/api/admin/verifiers',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404]
  },
  {
    method: 'GET',
    path: '/api/admin/verifiers/:userId',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404]
  },
  {
    method: 'POST',
    path: '/api/admin/verifiers',
    allowedRoles: [UserRole.ADMIN],
    body: { userId: 'test-user' },
    expectedSuccessStatus: [201, 404, 400]
  },
  {
    method: 'PATCH',
    path: '/api/admin/verifiers/:userId',
    allowedRoles: [UserRole.ADMIN],
    body: { status: 'ACTIVE' },
    expectedSuccessStatus: [200, 404, 400]
  },
  {
    method: 'DELETE',
    path: '/api/admin/verifiers/:userId',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404, 400]
  },
  {
    method: 'POST',
    path: '/api/admin/verifiers/:userId/approve',
    allowedRoles: [UserRole.ADMIN],
    expectedSuccessStatus: [200, 404, 400]
  },
  {
    method: 'POST',
    path: '/api/admin/verifiers/:userId/suspend',
    allowedRoles: [UserRole.ADMIN],
    body: { reason: 'Test suspension' },
    expectedSuccessStatus: [200, 404, 400]
  }
]

/**
 * Validate error response envelope format
 */
export function validateErrorEnvelope(
  response: Response, 
  expectedStatus: number, 
  errorPattern?: RegExp
): void {
  expect(response.status).toBe(expectedStatus)
  expect(response.body).toHaveProperty('error')
  expect(typeof response.body.error).toBe('string')
  expect(response.body.error.length).toBeGreaterThan(0)
  
  if (errorPattern) {
    expect(response.body.error).toMatch(errorPattern)
  }
  
  // Validate consistent error envelope structure
  if (expectedStatus === 401) {
    expect(response.body.error.toLowerCase()).toMatch(/unauthorized|invalid|expired|missing|malformed/)
  } else if (expectedStatus === 403) {
    expect(response.body.error.toLowerCase()).toMatch(/forbidden|requires|insufficient/)
  }
}

/**
 * Create role matrix test cases for systematic endpoint testing
 */
export function createRoleMatrixTests(endpoints: EndpointTestCase[]): Array<{
  endpoint: EndpointTestCase
  role: UserRole
  shouldHaveAccess: boolean
}> {
  const testCases: Array<{
    endpoint: EndpointTestCase
    role: UserRole
    shouldHaveAccess: boolean
  }> = []
  
  const allRoles = [UserRole.USER, UserRole.VERIFIER, UserRole.ADMIN]
  
  endpoints.forEach(endpoint => {
    allRoles.forEach(role => {
      testCases.push({
        endpoint,
        role,
        shouldHaveAccess: endpoint.allowedRoles.includes(role)
      })
    })
  })
  
  return testCases
}

/**
 * Generate test user data for database setup
 */
export function generateTestUser(role: UserRole, userId?: string) {
  return {
    userId: userId || `test-${role.toLowerCase()}`,
    email: `test-${role.toLowerCase()}@example.com`,
    role,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date()
  }
}

/**
 * Session management test utilities
 */
export function generateSessionToken(options: TokenGenerationOptions & { sessionId?: string }): string {
  const sessionId = options.sessionId || `session-${Date.now()}`
  
  return generateValidToken({
    ...options,
    jti: sessionId
  })
}

/**
 * Create comprehensive security test matrix
 */
export function createSecurityTestMatrix() {
  return {
    authenticationTests: [
      { name: 'missing-token', token: null, expectedStatus: 401 },
      { name: 'empty-token', token: '', expectedStatus: 401 },
      { name: 'malformed-token', token: INVALID_TOKENS.malformed(), expectedStatus: 401 },
      { name: 'expired-token', token: INVALID_TOKENS.expired(), expectedStatus: 401 },
      { name: 'wrong-secret', token: INVALID_TOKENS.wrongSecret(), expectedStatus: 401 }
    ],
    
    authorizationTests: [
      { name: 'user-to-admin', userRole: UserRole.USER, requiredRole: UserRole.ADMIN, expectedStatus: 403 },
      { name: 'user-to-verifier', userRole: UserRole.USER, requiredRole: UserRole.VERIFIER, expectedStatus: 403 },
      { name: 'verifier-to-admin', userRole: UserRole.VERIFIER, requiredRole: UserRole.ADMIN, expectedStatus: 403 }
    ],
    
    headerSpoofingTests: createSecurityBypassTests('/test-endpoint'),
    
    tokenManipulationTests: [
      { name: 'algorithm-confusion', manipulation: 'none-algorithm' },
      { name: 'signature-stripping', manipulation: 'remove-signature' },
      { name: 'payload-tampering', manipulation: 'modify-payload' },
      { name: 'header-tampering', manipulation: 'modify-header' }
    ]
  }
}

/**
 * Utility to replace path parameters in endpoint URLs
 */
export function replacePathParams(path: string, params: Record<string, string> = {}): string {
  let result = path
  
  // Default parameter replacements
  const defaultParams = {
    ':id': 'test-id',
    ':userId': 'test-user',
    ':milestoneId': 'test-milestone'
  }
  
  const allParams = { ...defaultParams, ...params }
  
  Object.entries(allParams).forEach(([param, value]) => {
    result = result.replace(param, value)
  })
  
  return result
}

/**
 * Performance testing utilities for property-based tests
 */
export function createPerformanceTestConfig() {
  return {
    propertyTestRuns: 100, // Minimum iterations per property test
    timeout: 30000, // 30 seconds per property test
    maxConcurrency: 10, // Maximum concurrent test executions
    
    // Deterministic seeds for reproducible property tests
    seeds: [
      42, 123, 456, 789, 1337, 2021, 2022, 2023, 2024, 2025
    ]
  }
}