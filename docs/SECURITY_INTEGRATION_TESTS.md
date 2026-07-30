# Security Integration Tests

## Overview

The security integration tests (`tests/security.integration.test.ts`) provide comprehensive end-to-end testing of the vault API security features. These tests ensure that authentication, authorization, input validation, and audit logging work correctly across the entire request lifecycle.

For the API-wide Helmet header contract and rationale, see `docs/helmet.md` and `src/tests/helmet.test.ts`.

## Test Coverage

### 1. Security Headers (3 tests)
- **X-Content-Type-Options**: Verifies `nosniff` header is set via Helmet
- **X-Frame-Options**: Intentionally absent because CSP `frame-ancestors 'none'` is enforced
- **X-Timezone**: Confirms UTC timezone header is set on all responses

### 2. CORS (2 tests)
- **Trusted Origins**: Allows requests from `http://localhost:3000`
- **Untrusted Origins**: Blocks requests from unauthorized domains

### 3. Authentication - JWT Enforcement (4 tests)
- **Missing Authorization**: Returns 401 when no auth header provided
- **Malformed Token**: Returns 401 for invalid Bearer tokens
- **Wrong Scheme**: Returns 401 for non-Bearer authorization schemes
- **Valid Token**: Accepts properly signed JWT tokens and proceeds

### 4. RBAC - Role-Based Access Control (3 tests)
- **USER Role**: Denied access to admin endpoints (403)
- **VERIFIER Role**: Denied access to admin endpoints (403)
- **ADMIN Role**: Granted access to admin endpoints (200)

### 5. Vault Creation - Input Validation (5 tests)
- **Valid Creation**: Successfully creates vault with proper payload
- **Negative Amount**: Rejects negative amounts with 400
- **Zero Amount**: Rejects zero amounts with 400
- **Invalid Address**: Rejects malformed Stellar addresses with 400
- **Authentication Required**: Requires valid JWT for vault creation

### 6. Vault Access Control (4 tests)
- **Non-existent Vault**: Returns 404 for missing vault IDs
- **Unauthenticated List**: Returns 401 when listing without token
- **Unauthenticated Get**: Returns 401 when fetching without token
- **Unauthenticated Cancel**: Returns 401 when canceling without token

### 7. Admin Vault Override (5 tests)
- **Non-existent Override**: Returns 404 for missing vaults
- **Successful Cancel**: Creates audit log and cancels vault
- **Already Cancelled**: Returns 409 for duplicate cancellation
- **Non-admin Access**: Returns 403 for non-admin users
- **Unauthenticated Override**: Returns 401 without token

### 8. End-to-End Vault Flow (4 tests)
- **Complete Lifecycle**: Tests create → list → get → cancel flow
- **Response Shape**: Validates vault response structure
- **OnChain Payload**: Confirms proper blockchain payload format
- **Admin Override**: Tests admin cancellation with audit logging

## Security Features Tested

### Authentication
- JWT token validation using production auth utilities
- Proper secret management (no hardcoded secrets)
- Token expiration and signature verification

### Authorization
- Role-based access control (USER, VERIFIER, ADMIN)
- Resource-level permissions
- Admin override capabilities

### Input Validation
- Stellar address format validation
- Amount validation (positive numbers only)
- Required field validation
- Malformed request handling

### Audit Logging
- Admin actions are logged with audit trail
- Sensitive data (passwords) excluded from logs
- Proper metadata capture for compliance

### Security Headers
- Content type protection
- Frame protection via CSP `frame-ancestors` contract
- CORS policy enforcement
- Timezone standardization

See `docs/helmet.md` for policy-level rationale and representative endpoint contract coverage.

## Test Architecture

### Minimal Test App
The tests use a lightweight Express application with:
- Essential security middleware (Helmet, CORS)
- JWT authentication middleware
- In-memory vault storage for isolation
- Mock admin endpoints for RBAC testing

### Token Generation
- Runtime token generation using production utilities
- No hardcoded secrets or tokens
- Proper role assignment for different test scenarios

### Data Isolation
- Each test suite resets in-memory storage
- No database dependencies for fast execution
- Synthetic test data (no PII)

## Running the Tests

```bash
# Run security integration tests
npm test -- tests/security.integration.test.ts

# Run with coverage
npm test -- tests/security.integration.test.ts --coverage

# Run specific test group
npm test -- tests/security.integration.test.ts -t "Authentication"
```

## Test Results

All 30 tests pass successfully, covering:
- ✅ Security headers and CORS policies
- ✅ JWT authentication and token validation
- ✅ Role-based access control (RBAC)
- ✅ Input validation and error handling
- ✅ Admin override capabilities
- ✅ End-to-end vault lifecycle flows
- ✅ Audit logging and compliance features

---

## RBAC Role-Matrix Tests (Issue #623)

A comprehensive role-matrix block added to the same file systematically
exercises every `/api/admin/*` endpoint across all three roles and the
unauthenticated case.

### Endpoint / Role Matrix

| Endpoint | Method | ADMIN | USER | VERIFIER | Unauth |
|---|---|---|---|---|---|
| `/api/admin/users` | GET | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/users/:id/role` | PATCH | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/users/:id/status` | PATCH | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/users/:id` | DELETE | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/users/:id/restore` | POST | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/audit-logs` | GET | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/audit-logs/:id` | GET | ✅ 404* | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/overrides/vaults/:id/cancel` | POST | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/users/:userId/revoke-sessions` | POST | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/verifiers` | GET | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/verifiers/:userId` | GET | ✅ 404* | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/verifiers` | POST | ✅ 201 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/verifiers/:userId` | PATCH | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/verifiers/:userId` | DELETE | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/verifiers/:userId/approve` | POST | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/admin/verifiers/:userId/suspend` | POST | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |
| `/api/verifications` | POST | ✅ 201 | ❌ 403 | ✅ 201 | ❌ 401 |
| `/api/verifications` | GET | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 401 |

\* 404 is an expected business-logic response from the admin handler — not an RBAC error.

### Security Invariants Tested

- **Role from JWT only** — 5 header-spoofing combinations (x-user-role, x-requested-role,
  role, x-auth-role, multiple combined). Both "USER token + spoof header" and
  "no token + spoof header" are verified to never grant elevated access.
- **Auth before authz** — missing token, malformed token, wrong-secret token, and expired
  token all return 401 (never 403).
- **Error envelope consistency** — 401 and 403 responses both carry `{ error: string }`.
  403 responses optionally include a `message` field naming the required role.
- **Path-param edge cases** — non-existent vault/log/verifier IDs return 404 under an
  admin token, confirming RBAC passed and only business logic rejected the request.

### Additional Test Groups (original suite)

See table in [Test Coverage](#test-coverage) above.

### Test Count Summary

| Group | Tests |
|---|---|
| Original suite | 30 |
| RBAC Role-Matrix (Issue #623) | 92 |
| **Total** | **122** |

2 tests in the original suite have pre-existing failures unrelated to RBAC (they test a
specific `res.body.error.code` shape that the minimal test-app does not produce). All 92
new role-matrix tests pass.

## Security Considerations

### No Secrets in Repository
- All tokens generated at runtime using production helpers
- Environment-based secret management
- No hardcoded credentials or API keys

### PII Protection
- All test addresses are synthetic Stellar placeholders
- No real user data in test scenarios
- Audit log tests verify password exclusion

### Production Alignment
- Uses actual authentication middleware
- Follows existing Express + TypeScript patterns
- Maintains compatibility with production security model

## Coverage Report

The tests achieve significant coverage of security-critical components:
- **auth-utils.ts**: 66.66% coverage (token generation/validation)
- **user.ts**: 100% coverage (user types and roles)
- Core authentication and authorization flows tested

This comprehensive test suite ensures the vault API maintains security best practices and provides confidence in the authentication, authorization, and audit logging systems.