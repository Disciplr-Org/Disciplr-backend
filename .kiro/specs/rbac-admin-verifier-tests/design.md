# Design Document: RBAC Admin Verifier Tests

## Overview

This design document outlines the technical implementation for comprehensive Role-Based Access Control (RBAC) policy tests for admin routes and verifier workflows in the Disciplr backend. The implementation addresses Issue #223 by strengthening test coverage across `/api/admin/*` and verifier-related endpoints to ensure robust security enforcement and prevent privilege escalation vulnerabilities.

The design focuses on creating a comprehensive test suite that validates the security assumptions of the RBAC system, particularly ensuring that role information is read exclusively from cryptographically verified JWT tokens and never from request headers.

## Architecture

### Codebase Reconnaissance Findings

**Current RBAC Implementation:**
- **Middleware Stack**: `authenticate` → `enforceRBAC`/`requireAdmin`/`requireVerifier`
- **Role Hierarchy**: USER < VERIFIER < ADMIN (hierarchical access model)
- **Token-Based Identity**: JWT tokens contain `userId`, `role`, and optional `jti` (session ID)
- **Security Model**: Role information read exclusively from `req.user.role` after JWT verification

**Existing Test Infrastructure:**
- **Test Framework**: Jest with TypeScript support and ESM modules
- **Property-Based Testing**: Fast-check library available in `src/tests/fixtures/arbitraries.ts`
- **Test Utilities**: Token generation utilities in existing test files
- **Coverage Requirements**: Global Jest configuration with coverage thresholds

**Admin Endpoints Discovered:**
- `/api/admin/users` (GET, PATCH role/status, DELETE, POST restore)
- `/api/admin/audit-logs` (GET, GET by ID)
- `/api/admin/overrides/vaults/:id/cancel` (POST)
- `/api/admin/users/:userId/revoke-sessions` (POST)
- `/api/admin/verifiers/*` (full CRUD + approve/suspend)

**Verifier Endpoints Discovered:**
- `/api/verifications` (POST for VERIFIER+, GET for ADMIN only)

### Test Architecture Strategy

The test implementation follows a **layered security testing approach**:

1. **Security Invariant Tests**: Core security assumptions and bypass prevention
2. **Endpoint Coverage Tests**: Systematic RBAC validation for all protected routes
3. **Integration Tests**: End-to-end RBAC enforcement with real middleware stack
4. **Utility Layer**: Reusable token generation and test helpers

## Components and Interfaces

### Test Utilities Module

**Location**: `src/tests/helpers/rbacTestUtils.ts`

```typescript
interface TokenGenerationOptions {
  userId?: string
  role: UserRole
  expiresIn?: string
  jti?: string
}

interface SecurityBypassTestCase {
  description: string
  headers: Record<string, string>
  expectedStatus: 401 | 403
  expectedErrorPattern: RegExp
}

interface EndpointTestCase {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  allowedRoles: UserRole[]
  body?: object
}
```

**Core Functions:**
- `generateValidToken(options: TokenGenerationOptions): string`
- `generateInvalidToken(type: 'malformed' | 'expired' | 'wrong-secret'): string`
- `createSecurityBypassTests(endpoint: string): SecurityBypassTestCase[]`
- `createRoleMatrixTests(endpoints: EndpointTestCase[]): TestCase[]`

### Enhanced Test Fixtures

**Location**: `src/tests/fixtures/rbacArbitraries.ts`

```typescript
// Property-based test generators for RBAC scenarios
export const arbitraryUserRole = (): fc.Arbitrary<UserRole>
export const arbitraryValidJWTPayload = (): fc.Arbitrary<JWTPayload>
export const arbitraryMaliciousHeaders = (): fc.Arbitrary<Record<string, string>>
export const arbitraryAdminEndpoint = (): fc.Arbitrary<EndpointTestCase>
```

### Test Suite Extensions

**Enhanced Files:**
1. `src/tests/rbac.test.ts` - Core RBAC logic and security invariants
2. `src/tests/admin.rbac.test.ts` - Admin endpoint comprehensive coverage
3. `src/tests/verifier.rbac.test.ts` - New file for verifier workflow tests
4. `src/tests/adminVerifiers.rbac.test.ts` - New file for admin verifier management tests

## Data Models

### Test Data Structures

```typescript
interface RBACTestContext {
  validTokens: {
    user: string
    verifier: string
    admin: string
  }
  invalidTokens: {
    malformed: string
    expired: string
    wrongSecret: string
  }
  testUsers: {
    userId: string
    role: UserRole
  }[]
}

interface EndpointSecurityProfile {
  path: string
  method: string
  allowedRoles: UserRole[]
  requiresBody: boolean
  expectedSuccessStatus: number[]
  bypassVulnerabilities: string[]
}
```

### Security Test Matrix

```typescript
const ADMIN_ENDPOINTS: EndpointSecurityProfile[] = [
  {
    path: '/api/admin/users',
    method: 'GET',
    allowedRoles: [UserRole.ADMIN],
    requiresBody: false,
    expectedSuccessStatus: [200],
    bypassVulnerabilities: ['header-spoofing', 'token-manipulation']
  },
  // ... comprehensive endpoint definitions
]

const VERIFIER_ENDPOINTS: EndpointSecurityProfile[] = [
  {
    path: '/api/verifications',
    method: 'POST',
    allowedRoles: [UserRole.VERIFIER, UserRole.ADMIN],
    requiresBody: true,
    expectedSuccessStatus: [201],
    bypassVulnerabilities: ['role-escalation', 'header-injection']
  }
]
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property Reflection

After analyzing all acceptance criteria, several properties can be consolidated to eliminate redundancy:

- Properties 1.1, 1.2, 1.4, 1.5, and 10.1 all test header spoofing prevention and can be combined into a comprehensive header isolation property
- Properties 2.1, 2.2, 2.3 test role-based access to admin endpoints and can be combined into an admin endpoint access control property
- Properties 3.1, 3.2, 3.3, 3.4, 3.5, 3.6 test verifier endpoint access and can be combined into a verifier endpoint access control property
- Properties 4.1, 4.2, 4.3 test verifier management access and can be combined into a verifier management access control property
- Properties 5.1, 5.2, 5.3, 5.4, 5.5 test authentication-before-authorization and can be combined into an authentication precedence property
- Properties 6.1, 6.2, 6.3, 6.4, 6.5 test error response consistency and can be combined into an error envelope consistency property
- Properties 10.2, 10.3, 10.4, 10.5 test security bypass prevention and can be combined with the header isolation property

### Property 1: Header Isolation and Security Bypass Prevention

*For any* valid JWT token with role R and any combination of request headers containing role information, the RBAC system SHALL make authorization decisions based exclusively on the JWT role R and SHALL ignore all header-based role information, preventing any form of privilege escalation through header manipulation, token forgery, or signature bypass attempts.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.2, 10.3, 10.4, 10.5**

### Property 2: Admin Endpoint Access Control

*For any* admin endpoint under `/api/admin/*` and any JWT token with role R, the RBAC system SHALL allow access if and only if R equals ADMIN, returning appropriate success responses (200, 201, 204, 404) for ADMIN tokens and 403 Forbidden for all other authenticated roles (USER, VERIFIER).

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 3: Verifier Endpoint Access Control

*For any* verifier-related endpoint (`/api/verifications`) and any JWT token with role R, the RBAC system SHALL enforce role hierarchy where POST access is granted to VERIFIER and ADMIN roles, GET access is granted only to ADMIN role, and USER role is denied access with 403 Forbidden.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

### Property 4: Verifier Management Access Control

*For any* verifier management endpoint under `/api/admin/verifiers/*` and any JWT token with role R, the RBAC system SHALL allow access if and only if R equals ADMIN, denying access to VERIFIER and USER roles with 403 Forbidden status.

**Validates: Requirements 4.1, 4.2, 4.3**

### Property 5: Authentication Precedence Invariant

*For any* protected endpoint and any request with authentication state S (missing, malformed, invalid, expired, or valid), the RBAC system SHALL return 401 Unauthorized for all invalid authentication states (missing, malformed, invalid, expired) and SHALL only return 403 Forbidden after successful authentication when the valid token has insufficient role permissions.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

### Property 6: Error Envelope Consistency

*For any* RBAC-related error condition (authentication failure or authorization failure), the RBAC system SHALL return a consistent JSON error envelope containing an "error" field with descriptive string message, optionally including a "message" field for detailed role requirements, with 401 status containing "Unauthorized" and 403 status containing "Forbidden".

**Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

## Error Handling

### Authentication Error Handling

**Token Validation Errors:**
- **Missing Token**: Return 401 with `{ error: "Missing or malformed Authorization header" }`
- **Malformed Token**: Return 401 with `{ error: "Invalid token" }`
- **Expired Token**: Return 401 with `{ error: "Token expired" }`
- **Invalid Signature**: Return 401 with `{ error: "Invalid token" }`

**Session Validation Errors:**
- **Revoked Session**: Return 401 with `{ error: "Session revoked or expired" }`

### Authorization Error Handling

**Role-Based Access Errors:**
- **Insufficient Role**: Return 403 with `{ error: "Forbidden", message: "Requires role: ADMIN" }`
- **Missing User Context**: Return 401 with `{ error: "Unauthorized" }`

### Test Error Handling

**Test Execution Errors:**
- **Token Generation Failures**: Fail fast with descriptive error messages
- **Network/HTTP Errors**: Retry with exponential backoff for transient failures
- **Database Connection Errors**: Skip tests with clear skip reason
- **Property Test Failures**: Include counterexample in failure message

## Testing Strategy

### Dual Testing Approach

**Unit Tests:**
- Specific examples of RBAC enforcement scenarios
- Edge cases and error conditions
- Middleware isolation testing
- Token generation and validation utilities

**Property-Based Tests:**
- Universal properties across all valid inputs (minimum 100 iterations per property)
- Comprehensive input coverage through randomization
- Security bypass attempt validation
- Error response consistency verification

### Property Test Configuration

**Test Framework**: Jest with fast-check integration
**Iterations**: Minimum 100 per property test
**Timeout**: 30 seconds per property test
**Shrinking**: Enabled for counterexample minimization

**Property Test Tags**:
- **Feature: rbac-admin-verifier-tests, Property 1**: Header isolation and security bypass prevention
- **Feature: rbac-admin-verifier-tests, Property 2**: Admin endpoint access control
- **Feature: rbac-admin-verifier-tests, Property 3**: Verifier endpoint access control
- **Feature: rbac-admin-verifier-tests, Property 4**: Verifier management access control
- **Feature: rbac-admin-verifier-tests, Property 5**: Authentication precedence invariant
- **Feature: rbac-admin-verifier-tests, Property 6**: Error envelope consistency

### Test Coverage Requirements

**Coverage Targets:**
- **RBAC Middleware**: 95% branch coverage minimum
- **Authentication Middleware**: 95% branch coverage minimum
- **Admin Routes**: 100% endpoint coverage
- **Verifier Routes**: 100% endpoint coverage

**Coverage Exclusions:**
- Database connection setup/teardown
- Environment variable loading
- Logging statements (console.log, console.error)

### Test File Organization

**Enhanced Existing Files:**
1. `src/tests/rbac.test.ts` - Core RBAC logic and security invariants
2. `src/tests/admin.rbac.test.ts` - Admin endpoint comprehensive coverage

**New Test Files:**
3. `src/tests/verifier.rbac.test.ts` - Verifier workflow RBAC tests
4. `src/tests/adminVerifiers.rbac.test.ts` - Admin verifier management RBAC tests
5. `src/tests/helpers/rbacTestUtils.ts` - Shared test utilities and token generation

**Test Utilities:**
6. `src/tests/fixtures/rbacArbitraries.ts` - Property-based test generators for RBAC scenarios

### Security Testing Methodology

**Threat Model Coverage:**
1. **Header Spoofing**: Attempt role escalation via request headers
2. **Token Manipulation**: Forge or modify JWT tokens
3. **Signature Bypass**: Attempt to bypass cryptographic verification
4. **Session Hijacking**: Test session validation and revocation
5. **Role Escalation**: Attempt to access higher-privilege endpoints
6. **Authentication Bypass**: Attempt to access protected resources without authentication

**Security Test Categories:**
- **Positive Security Tests**: Verify legitimate access works correctly
- **Negative Security Tests**: Verify unauthorized access is properly denied
- **Boundary Tests**: Test edge cases and boundary conditions
- **Bypass Tests**: Attempt various security bypass techniques

### Integration with CI/CD

**Test Execution:**
- All tests must pass existing CI checks (TypeScript, ESLint, Prettier)
- Property tests run with deterministic seeds for reproducibility
- Test execution time limit: 5 minutes total for RBAC test suite
- Parallel test execution where possible

**Failure Reporting:**
- Clear failure messages with counterexamples for property tests
- Security test failures marked as critical
- Coverage reports integrated with existing tooling
- Test results exported in JUnit format for CI integration

### Test Database Setup

**Database Requirements:**
- Use existing test database setup from `src/tests/helpers/testDatabase.ts`
- Ensure test isolation with proper setup/teardown
- Mock external dependencies (Stellar network, third-party APIs)
- Use transaction rollback for test data cleanup

**Test Data Management:**
- Generate test users with known IDs and roles
- Create test JWT tokens with controlled expiration
- Use deterministic test data for reproducible results
- Clean up test sessions and audit logs after tests

## Implementation Plan

### Phase 1: Test Infrastructure Setup (Week 1)

**Deliverables:**
1. **Test Utilities Module** (`src/tests/helpers/rbacTestUtils.ts`)
   - Token generation functions for all roles
   - Invalid token generation (malformed, expired, wrong secret)
   - Security bypass test case generators
   - Endpoint test case generators

2. **RBAC Arbitraries Module** (`src/tests/fixtures/rbacArbitraries.ts`)
   - Property-based test generators for JWT payloads
   - Malicious header generators
   - Admin endpoint generators
   - Verifier endpoint generators

3. **Enhanced Test Database Setup**
   - Extend existing test database helpers
   - Add RBAC-specific test user creation
   - Add session management test utilities

### Phase 2: Core Security Tests (Week 2)

**Deliverables:**
1. **Enhanced `src/tests/rbac.test.ts`**
   - Property 1: Header isolation and security bypass prevention
   - Property 5: Authentication precedence invariant
   - Property 6: Error envelope consistency
   - Security bypass attempt tests

2. **Test Coverage Validation**
   - Verify 95% branch coverage for RBAC middleware
   - Implement missing test cases for edge conditions
   - Add property-based tests for core security invariants

### Phase 3: Admin Endpoint Coverage (Week 3)

**Deliverables:**
1. **Enhanced `src/tests/admin.rbac.test.ts`**
   - Property 2: Admin endpoint access control
   - Comprehensive coverage of all admin endpoints
   - Integration tests with real middleware stack

2. **New `src/tests/adminVerifiers.rbac.test.ts`**
   - Property 4: Verifier management access control
   - Full CRUD lifecycle testing with RBAC enforcement
   - Admin-only verifier management validation

### Phase 4: Verifier Workflow Tests (Week 4)

**Deliverables:**
1. **New `src/tests/verifier.rbac.test.ts`**
   - Property 3: Verifier endpoint access control
   - Role hierarchy validation (VERIFIER < ADMIN)
   - Verification workflow RBAC enforcement

2. **Integration Testing**
   - End-to-end RBAC validation across all protected routes
   - Cross-endpoint security validation
   - Performance testing for property-based tests

### Phase 5: Documentation and CI Integration (Week 5)

**Deliverables:**
1. **Updated Documentation**
   - Enhanced `docs/auth.md` with comprehensive role definitions
   - Endpoint access matrix documentation
   - Security testing methodology documentation

2. **CI/CD Integration**
   - Test suite integration with existing CI pipeline
   - Coverage reporting integration
   - Security test failure alerting

3. **Final Validation**
   - Complete test suite execution
   - Coverage threshold validation
   - Security audit of test implementation

### Technical Implementation Details

**Token Generation Strategy:**
```typescript
// Use existing JWT_ACCESS_SECRET for consistency
const generateTestToken = (payload: JWTPayload, options?: TokenOptions) => {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || "change-me-in-production"
  return jwt.sign(payload, secret, { expiresIn: options?.expiresIn || '1h' })
}
```

**Property Test Implementation Pattern:**
```typescript
// Example property test structure
it('Property 1: Header isolation', () => {
  fc.assert(fc.property(
    arbitraryValidJWTPayload(),
    arbitraryMaliciousHeaders(),
    arbitraryAdminEndpoint(),
    async (jwtPayload, headers, endpoint) => {
      const token = generateTestToken(jwtPayload)
      const response = await request(app)
        [endpoint.method.toLowerCase()](endpoint.path)
        .set('Authorization', `Bearer ${token}`)
        .set(headers)
      
      // Verify authorization decision based only on JWT role
      const expectedStatus = endpoint.allowedRoles.includes(jwtPayload.role) ? 200 : 403
      expect(response.status).toBe(expectedStatus)
    }
  ), { numRuns: 100 })
})
```

**Security Test Implementation:**
```typescript
// Security bypass test pattern
const securityBypassTests = [
  {
    name: 'Header spoofing with x-user-role',
    setup: (userRole: UserRole) => ({
      token: generateTestToken({ userId: 'test', role: userRole }),
      headers: { 'x-user-role': 'ADMIN' }
    }),
    expectation: (userRole: UserRole) => userRole === UserRole.ADMIN ? [200, 404] : [403]
  }
  // ... additional bypass tests
]
```

This comprehensive design provides a robust foundation for implementing comprehensive RBAC tests that will strengthen the security posture of the Disciplr backend and prevent privilege escalation vulnerabilities.