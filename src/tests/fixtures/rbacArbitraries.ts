import fc from 'fast-check'
import { UserRole } from '../../types/user.js'
import { EndpointTestCase } from '../helpers/rbacTestUtils.js'

/**
 * RBAC Property-Based Test Arbitraries
 * 
 * Provides fast-check arbitraries for generating test data for comprehensive
 * RBAC property-based testing. These generators create randomized inputs
 * to validate universal security properties.
 */

/**
 * Generate arbitrary user roles
 */
export const arbitraryUserRole = (): fc.Arbitrary<UserRole> => {
  return fc.constantFrom(UserRole.USER, UserRole.VERIFIER, UserRole.ADMIN)
}

/**
 * Generate arbitrary valid JWT payloads
 */
export const arbitraryValidJWTPayload = (): fc.Arbitrary<{
  userId: string
  role: UserRole
  email?: string
  jti?: string
}> => {
  return fc.record({
    userId: fc.string({ minLength: 1, maxLength: 50 }),
    role: arbitraryUserRole(),
    email: fc.option(fc.emailAddress()),
    jti: fc.option(fc.uuid())
  })
}

/**
 * Generate arbitrary malicious headers for security bypass testing
 */
export const arbitraryMaliciousHeaders = (): fc.Arbitrary<Record<string, string>> => {
  const roleHeaders = [
    'x-user-role',
    'x-requested-role', 
    'role',
    'x-auth-role',
    'authorization-role',
    'user-role',
    'requested-role',
    'auth-role',
    'x-role',
    'custom-role'
  ]
  
  const privilegedRoles = [
    'ADMIN',
    'SUPERUSER',
    'ROOT',
    'SUPERADMIN',
    'SYSTEM',
    'ADMINISTRATOR',
    'admin',
    'Admin',
    'ADMIN_USER',
    'POWER_USER'
  ]
  
  return fc.dictionary(
    fc.constantFrom(...roleHeaders),
    fc.constantFrom(...privilegedRoles),
    { minKeys: 1, maxKeys: 5 }
  )
}

/**
 * Generate arbitrary admin endpoints
 */
export const arbitraryAdminEndpoint = (): fc.Arbitrary<EndpointTestCase> => {
  const adminPaths = [
    '/api/admin/users',
    '/api/admin/users/:id',
    '/api/admin/users/:id/role',
    '/api/admin/users/:id/status',
    '/api/admin/audit-logs',
    '/api/admin/audit-logs/:id',
    '/api/admin/overrides/vaults/:id/cancel',
    '/api/admin/users/:userId/revoke-sessions',
    '/api/admin/verifiers',
    '/api/admin/verifiers/:userId',
    '/api/admin/verifiers/:userId/approve',
    '/api/admin/verifiers/:userId/suspend'
  ]
  
  return fc.record({
    method: fc.constantFrom('GET', 'POST', 'PATCH', 'DELETE'),
    path: fc.constantFrom(...adminPaths),
    allowedRoles: fc.constant([UserRole.ADMIN]), // Admin endpoints are admin-only
    body: fc.option(fc.object()).map(obj => obj || undefined),
    expectedSuccessStatus: fc.option(fc.array(fc.integer({ min: 200, max: 299 }))).map(arr => arr || undefined)
  })
}

/**
 * Generate arbitrary verifier endpoints
 */
export const arbitraryVerifierEndpoint = (): fc.Arbitrary<EndpointTestCase> => {
  return fc.oneof(
    // POST /api/verifications - VERIFIER + ADMIN access
    fc.record({
      method: fc.constant('POST' as const),
      path: fc.constant('/api/verifications'),
      allowedRoles: fc.constant([UserRole.VERIFIER, UserRole.ADMIN]),
      body: fc.option(fc.object()).map(obj => obj || undefined),
      expectedSuccessStatus: fc.option(fc.array(fc.constantFrom(201, 404, 400))).map(arr => arr || undefined)
    }),
    // GET /api/verifications - ADMIN only
    fc.record({
      method: fc.constant('GET' as const),
      path: fc.constant('/api/verifications'),
      allowedRoles: fc.constant([UserRole.ADMIN]),
      body: fc.option(fc.object()).map(obj => obj || undefined),
      expectedSuccessStatus: fc.option(fc.array(fc.constantFrom(200, 404))).map(arr => arr || undefined)
    })
  )
}

/**
 * Generate arbitrary authentication states
 */
export const arbitraryAuthenticationState = (): fc.Arbitrary<{
  hasToken: boolean
  tokenValid: boolean
  tokenExpired: boolean
  tokenMalformed: boolean
  signatureValid: boolean
}> => {
  return fc.record({
    hasToken: fc.boolean(),
    tokenValid: fc.boolean(),
    tokenExpired: fc.boolean(),
    tokenMalformed: fc.boolean(),
    signatureValid: fc.boolean()
  })
}

/**
 * Generate arbitrary security bypass attempts
 */
export const arbitrarySecurityBypassAttempt = (): fc.Arbitrary<{
  method: string
  expectedOutcome: 'denied' | 'unauthorized'
  headers?: Record<string, string>
  tokenManipulation?: string
}> => {
  return fc.oneof(
    // Header spoofing attempts
    fc.record({
      method: fc.constant('header-spoofing'),
      expectedOutcome: fc.constant('denied' as const),
      headers: arbitraryMaliciousHeaders()
    }),
    // Token manipulation attempts
    fc.record({
      method: fc.constant('token-manipulation'),
      expectedOutcome: fc.constant('unauthorized' as const),
      tokenManipulation: fc.constantFrom(
        'malformed', 'expired', 'wrong-secret', 'empty', 'null',
        'algorithm-confusion', 'signature-stripping', 'payload-tampering'
      )
    }),
    // Signature bypass attempts
    fc.record({
      method: fc.constant('signature-bypass'),
      expectedOutcome: fc.constant('unauthorized' as const),
      tokenManipulation: fc.constantFrom('none-algorithm', 'remove-signature', 'weak-secret')
    })
  )
}

/**
 * Generate arbitrary role hierarchy scenarios
 */
export const arbitraryRoleHierarchyScenario = (): fc.Arbitrary<{
  requiredRoles: UserRole[]
  userRole: UserRole
  shouldHaveAccess: boolean
}> => {
  return fc.tuple(
    fc.array(arbitraryUserRole(), { minLength: 1, maxLength: 3 }),
    arbitraryUserRole()
  ).map(([requiredRoles, userRole]) => {
    // Implement proper role hierarchy logic
    let shouldHaveAccess = requiredRoles.includes(userRole)
    
    // Role hierarchy: USER < VERIFIER < ADMIN
    // Higher roles can access lower-level resources
    if (!shouldHaveAccess) {
      if (userRole === UserRole.ADMIN && 
          (requiredRoles.includes(UserRole.VERIFIER) || requiredRoles.includes(UserRole.USER))) {
        shouldHaveAccess = true
      } else if (userRole === UserRole.VERIFIER && requiredRoles.includes(UserRole.USER)) {
        shouldHaveAccess = true
      }
    }
    
    return {
      requiredRoles,
      userRole,
      shouldHaveAccess
    }
  })
}

/**
 * Generate arbitrary token manipulation scenarios
 */
export const arbitraryTokenManipulationScenario = (): fc.Arbitrary<{
  manipulationType: string
  expectedStatus: number
}> => {
  return fc.record({
    manipulationType: fc.constantFrom(
      'empty', 'null', 'malformed', 'expired', 'wrong-secret',
      'missing-claims', 'invalid-signature', 'algorithm-confusion',
      'payload-tampering', 'header-tampering'
    ),
    expectedStatus: fc.constant(401) // All token manipulation should result in 401
  })
}

/**
 * Generate arbitrary endpoint access scenarios
 */
export const arbitraryEndpointAccessScenario = (): fc.Arbitrary<{
  endpoint: EndpointTestCase
  userRole: UserRole
  hasValidToken: boolean
  maliciousHeaders: Record<string, string>
}> => {
  return fc.record({
    endpoint: fc.oneof(arbitraryAdminEndpoint(), arbitraryVerifierEndpoint()),
    userRole: arbitraryUserRole(),
    hasValidToken: fc.boolean(),
    maliciousHeaders: arbitraryMaliciousHeaders()
  })
}

/**
 * Generate arbitrary error response scenarios
 */
export const arbitraryErrorResponseScenario = (): fc.Arbitrary<{
  statusCode: 401 | 403
  errorType: string
  shouldHaveMessage: boolean
}> => {
  return fc.record({
    statusCode: fc.constantFrom(401, 403),
    errorType: fc.oneof(
      // 401 error types
      fc.record({
        statusCode: fc.constant(401),
        type: fc.constantFrom('unauthorized', 'invalid-token', 'expired-token', 'missing-auth')
      }),
      // 403 error types  
      fc.record({
        statusCode: fc.constant(403),
        type: fc.constantFrom('forbidden', 'insufficient-role', 'access-denied')
      })
    ).map(({ type }) => type),
    shouldHaveMessage: fc.boolean()
  })
}

/**
 * Generate arbitrary JWT claims for testing
 */
export const arbitraryJWTClaims = (): fc.Arbitrary<Record<string, any>> => {
  return fc.record({
    // Standard claims
    userId: fc.string({ minLength: 1, maxLength: 50 }),
    role: arbitraryUserRole(),
    email: fc.option(fc.emailAddress()),
    jti: fc.option(fc.uuid()),
    
    // Potential malicious claims
    adminRole: fc.option(fc.constantFrom('ADMIN', 'SUPERUSER', 'ROOT')),
    customRole: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
    privileges: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 20 }))),
    permissions: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 20 }))),
    
    // Timing claims
    iat: fc.option(fc.integer({ min: 1600000000, max: 2000000000 })),
    exp: fc.option(fc.integer({ min: 1600000000, max: 2000000000 })),
    nbf: fc.option(fc.integer({ min: 1600000000, max: 2000000000 }))
  })
}

/**
 * Generate arbitrary HTTP request scenarios
 */
export const arbitraryHTTPRequestScenario = (): fc.Arbitrary<{
  method: string
  path: string
  headers: Record<string, string>
  body?: any
  hasAuth: boolean
}> => {
  return fc.record({
    method: fc.constantFrom('GET', 'POST', 'PATCH', 'DELETE', 'PUT'),
    path: fc.oneof(
      fc.constantFrom(
        '/api/admin/users',
        '/api/admin/audit-logs', 
        '/api/verifications',
        '/api/admin/verifiers'
      ),
      fc.string({ minLength: 1, maxLength: 100 }).map(s => `/api/${s}`)
    ),
    headers: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 100 }),
      { maxKeys: 10 }
    ),
    body: fc.option(fc.object()),
    hasAuth: fc.boolean()
  })
}

/**
 * Generate arbitrary session scenarios
 */
export const arbitrarySessionScenario = (): fc.Arbitrary<{
  hasSession: boolean
  sessionValid: boolean
  sessionExpired: boolean
  sessionRevoked: boolean
  jti?: string
}> => {
  return fc.record({
    hasSession: fc.boolean(),
    sessionValid: fc.boolean(),
    sessionExpired: fc.boolean(),
    sessionRevoked: fc.boolean(),
    jti: fc.option(fc.uuid())
  })
}

/**
 * Generate arbitrary RBAC configuration scenarios
 */
export const arbitraryRBACConfigScenario = (): fc.Arbitrary<{
  allowedRoles: UserRole[]
  denyByDefault: boolean
  requireAuthentication: boolean
  logDenials: boolean
}> => {
  return fc.record({
    allowedRoles: fc.array(arbitraryUserRole(), { minLength: 0, maxLength: 3 }),
    denyByDefault: fc.boolean(),
    requireAuthentication: fc.boolean(),
    logDenials: fc.boolean()
  })
}

/**
 * Generate arbitrary security audit scenarios
 */
export const arbitrarySecurityAuditScenario = (): fc.Arbitrary<{
  attemptType: string
  sourceIP: string
  userAgent: string
  timestamp: Date
  succeeded: boolean
  riskLevel: 'low' | 'medium' | 'high'
}> => {
  return fc.record({
    attemptType: fc.constantFrom(
      'header-spoofing', 'token-manipulation', 'privilege-escalation',
      'brute-force', 'session-hijacking', 'csrf', 'injection'
    ),
    sourceIP: fc.ipV4(),
    userAgent: fc.string({ minLength: 10, maxLength: 200 }),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
    succeeded: fc.boolean(),
    riskLevel: fc.constantFrom('low', 'medium', 'high')
  })
}

/**
 * Generate arbitrary performance test scenarios
 */
export const arbitraryPerformanceScenario = (): fc.Arbitrary<{
  concurrentRequests: number
  requestsPerSecond: number
  testDuration: number
  expectedLatency: number
}> => {
  return fc.record({
    concurrentRequests: fc.integer({ min: 1, max: 100 }),
    requestsPerSecond: fc.integer({ min: 1, max: 1000 }),
    testDuration: fc.integer({ min: 1, max: 60 }), // seconds
    expectedLatency: fc.integer({ min: 1, max: 5000 }) // milliseconds
  })
}

/**
 * Composite arbitrary for comprehensive RBAC testing
 */
export const arbitraryRBACTestScenario = (): fc.Arbitrary<{
  user: { userId: string; role: UserRole; email?: string }
  endpoint: EndpointTestCase
  request: { headers: Record<string, string>; body?: any }
  security: { bypassAttempt?: any; tokenManipulation?: string }
  expected: { status: number; hasAccess: boolean }
}> => {
  return fc.record({
    user: fc.record({
      userId: fc.string({ minLength: 1, maxLength: 50 }),
      role: arbitraryUserRole(),
      email: fc.option(fc.emailAddress())
    }),
    endpoint: fc.oneof(arbitraryAdminEndpoint(), arbitraryVerifierEndpoint()),
    request: fc.record({
      headers: arbitraryMaliciousHeaders(),
      body: fc.option(fc.object())
    }),
    security: fc.record({
      bypassAttempt: fc.option(arbitrarySecurityBypassAttempt()),
      tokenManipulation: fc.option(fc.constantFrom(
        'malformed', 'expired', 'wrong-secret', 'empty'
      ))
    }),
    expected: fc.record({
      status: fc.constantFrom(200, 401, 403, 404),
      hasAccess: fc.boolean()
    })
  })
}

/**
 * Generate deterministic test seeds for reproducible property tests
 */
export const deterministicSeeds = [
  42, 123, 456, 789, 1337, 2021, 2022, 2023, 2024, 2025,
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1000
]

/**
 * Property test configuration
 */
export const propertyTestConfig = {
  numRuns: 100,
  timeout: 30000,
  maxSkipsPerRun: 100,
  seed: deterministicSeeds[0], // Use first seed as default
  path: [], // For shrinking
  endOnFailure: false
}