# Authentication & Authorization

## Overview

The Disciplr backend enforces Role-Based Access Control (RBAC) across all protected endpoints. This document describes the role definitions, enforcement model, and trust hierarchy.

User role and `lastLoginAt` state are persisted in the `users` table and read through Prisma-backed queries. The auth router does not maintain any in-process mock user cache, so role changes survive process restarts and future logins.

## Registration

Endpoint: `POST /api/auth/register`

### Request Body
```json
{
  "email": "user@example.com",
  "password": "securepassword123",
  "role": "USER"
}
```
- `role` is optional (defaults to `USER`). Options: `USER`, `VERIFIER`, `ADMIN`.

### Response (201 Created)
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "role": "USER"
}
```

### Errors
- `400 Bad Request`: Validation failure or missing fields.
- `409 Conflict`: Email already in use.
```json
{
  "error": "Email already in use"
}
```

## Security Assumptions
- Passwords are hashed using `bcryptjs` with a cost factor of 12.
- Email existence is not leaked during login (generic "Invalid credentials" error).
- Password hashes are never returned in registration or login responses.
- Role changes are persisted to the database and later read from the same `users` row.
- Audit log metadata excludes email addresses and other request-body PII.

## Role Definitions

Disciplr defines three primary user roles with a hierarchical access model: **USER** < **VERIFIER** < **ADMIN**.

### USER Role

**Description:** Standard authenticated user with basic access.

**Capabilities:**
- Create and manage personal vaults
- Submit milestones for verification
- Access user-scoped data and endpoints
- View their own profile and session history

**Cannot access:**
- Verifier verification endpoints
- Admin management endpoints
- Audit logs
- Verifier lifecycle management
- System overrides

**Location in codebase:** Defined as `UserRole.USER` enum in [src/types/user.ts](../src/types/user.ts#L1).

### VERIFIER Role

**Description:** Trusted verifier who reviews and validates milestones and other verification tasks.

**Capabilities:**
- All USER-level capabilities (hierarchical)
- Access `/api/verifications` to record milestone verifications
- Access `/api/vaults/:vaultId/milestones/:id/verify` to verify milestones
- Participate in vault completion workflows

**Cannot access:**
- Verifier profile management (CRUD on `/api/admin/verifiers`)
- Admin audit logs
- User management endpoints
- System overrides

**Location in codebase:** Defined as `UserRole.VERIFIER` enum in [src/types/user.ts](../src/types/user.ts#L2).

### ADMIN Role

**Description:** System administrator with full access to all resources, user management, and system operations.

**Capabilities:**
- All USER and VERIFIER-level capabilities (hierarchical)
- Access `/api/admin/*` endpoints for:
  - User management (list, role/status updates, soft/hard delete, restore)
  - Verifier profile management (create, read, update, delete, approve/suspend)
  - Audit log retrieval and filtering
  - System overrides (e.g., vault cancellations)
- View complete audit trail
- Perform administrative actions on user accounts and verifier profiles

**Cannot be limited by:**
- Restricted to their own data (admins see all data)
- Read-only operations (admins can write to all resources)

**Location in codebase:** Defined as `UserRole.ADMIN` enum in [src/types/user.ts](../src/types/user.ts#L3).

## Enforcement Model

### Trust Hierarchy and Token-Based Identity

The enforcement model follows a **token-driven trust hierarchy**:

1. **Token Verification:** All protected routes require an `Authorization: Bearer <JWT>` header.
2. **Role Extraction:** The JWT token is cryptographically verified using `JWT_ACCESS_SECRET`.
3. **Role Assignment:** After verification, the token payload is extracted and `req.user.role` is set by the `authenticate` middleware.
4. **Authorization Check:** The `authorize()` or `enforceRBAC()` middleware reads **exclusively** from `req.user.role`.
5. **Deny by Default:** If `req.user.role` is not in the whitelist for a protected route, the request is rejected with `403 Forbidden`.

### Persisted User State

- The source of truth for user role and `lastLoginAt` is the `users` table.
- `AuthService.login()` updates `lastLoginAt` as part of the login write path.
- Legacy `POST /api/auth/login` requests that provide only `userId` read the persisted user row instead of fabricating in-memory role state.
- Administrative role updates write through to the database, so subsequent requests and restarts observe the same role.

### Request Headers: Untrusted

**Critical Security Invariant:**

Request headers such as `x-user-role`, `x-requested-role`, or any other role-bearing header are **completely ignored** by the authorization middleware. They are **not trusted** because they are under client control and can be forged.

The only trusted source of role information is `req.user.role`, which is set only after cryptographic JWT verification.

### Authentication Before Authorization

The middleware chain enforces **authentication before authorization**:

1. An unauthenticated request (missing or invalid token) receives `401 Unauthorized`.
2. Only after authentication succeeds does authorization checking occur.
3. A request that fails authorization receives `403 Forbidden`.

This invariant ensures that a request is never rejected for insufficient permissions without first confirming the identity of the requester.

## Error Responses

### 401 Unauthorized

Returned when:
- No `Authorization` header is provided.
- The `Authorization` header does not start with `Bearer `.
- The JWT token is malformed or has an invalid signature.
- The JWT token has expired.

**Response body:**
```json
{
  "error": "Unauthorized: Missing or invalid token"
}
```

or

```json
{
  "error": "Unauthorized: Token expired or invalid"
}
```

### 403 Forbidden

Returned when:
- The request is authenticated (valid token) but `req.user.role` is not in the endpoint's whitelist.

**Response body (from `authorize()` middleware):**
```json
{
  "error": "Forbidden: Insufficient permissions"
}
```

**Response body (from `enforceRBAC()` middleware):**
```json
{
  "error": "Forbidden",
  "message": "Requires role: ADMIN"
}
```

## Endpoint Access Matrix

| Endpoint Group | USER | VERIFIER | ADMIN |
|---|---|---|---|
| `/api/vaults` (user's vaults) | ✓ | ✓ | ✓ |
| `/api/verifications` (POST) | ✗ | ✓ | ✓ |
| `/api/verifications` (GET) | ✗ | ✗ | ✓ |
| `/api/vaults/:id/milestones/` (POST) | ✓ | ✓ | ✓ |
| `/api/vaults/:id/milestones/:id/verify` (PATCH) | ✗ | ✓ | ✓ |
| `/api/admin/audit-logs` (GET) | ✗ | ✗ | ✓ |
| `/api/admin/users` | ✗ | ✗ | ✓ |
| `/api/admin/users/:id/role` (PATCH) | ✗ | ✗ | ✓ |
| `/api/admin/users/:id/status` (PATCH) | ✗ | ✗ | ✓ |
| `/api/admin/users/:id` (DELETE) | ✗ | ✗ | ✓ |
| `/api/admin/users/:id/restore` (POST) | ✗ | ✗ | ✓ |
| `/api/admin/verifiers` | ✗ | ✗ | ✓ |
| `/api/admin/verifiers/:userId` | ✗ | ✗ | ✓ |
| `/api/admin/verifiers/:userId/approve` (POST) | ✗ | ✗ | ✓ |
| `/api/admin/verifiers/:userId/suspend` (POST) | ✗ | ✗ | ✓ |
| `/api/admin/overrides/vaults/:id/cancel` (POST) | ✗ | ✗ | ✓ |

## Middleware Implementation

### authenticate()

**Location:** [src/middleware/auth.middleware.ts](../src/middleware/auth.middleware.ts#L5)

Verifies the JWT token and extracts the `userId` and `role` into `req.user`:

```typescript
export const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization

    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' })
    }

    const token = authHeader.split(' ')[1]

    try {
        const payload = verifyAccessToken(token)
        req.user = {
            userId: payload.userId,
            role: payload.role as UserRole,
        }
        next()
    } catch (error) {
        return res.status(401).json({ error: 'Unauthorized: Token expired or invalid' })
    }
}
```

### authorize()

**Location:** [src/middleware/auth.middleware.ts](../src/middleware/auth.middleware.ts#L25)

Checks whether `req.user.role` is in the allowed roles:

```typescript
export const authorize = (roles: UserRole[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden: Insufficient permissions' })
        }
        next()
    }
}
```

### enforceRBAC()

**Location:** [src/middleware/rbac.ts](../src/middleware/rbac.ts#L23)

A more detailed RBAC enforcement middleware that logs denied access:

```typescript
export const enforceRBAC = (options: RBACOptions) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      logRBACDenied(req, "missing_user");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!options.allow.includes(req.user.role)) {
      logRBACDenied(req, "insufficient_role");
      res.status(403).json({
        error: "Forbidden",
        message: `Requires role: ${options.allow.join(", ")}`,
      });
      return;
    }

    next();
  };
};
```

## Token Generation

Access tokens are generated using `generateAccessToken()` from [src/lib/auth-utils.ts](../src/lib/auth-utils.ts#L15):

```typescript
export const generateAccessToken = (payload: { userId: string; role: string; jti?: string }): string => {
    const fullPayload = {
        ...payload,
        jti: payload.jti || randomUUID()
    }
    return jwt.sign(fullPayload, ACCESS_SECRET, {
        expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as any,
    })
}
```

**Token Payload:**
- `userId`: The unique identifier for the authenticated user
- `role`: The user's role (USER, VERIFIER, or ADMIN)
- `jti`: JWT ID (unique identifier for this token, optional)
- Standard JWT claims: `iat` (issued at), `exp` (expiration time)

**Secrets:**
- `JWT_ACCESS_SECRET`: Environment variable that must be kept secure in production.
- Fallback: If not set, defaults to `'fallback-access-secret'` (development only).

## Security Principles

1. **Zero Trust for Headers:** No request header can override or bypass role information from the token.
2. **Cryptographic Verification:** All identity information derives from a cryptographically signed JWT.
3. **Role Immutability:** A token's role cannot change mid-request or be modified by the client.
4. **Deny by Default:** If no middleware explicitly grants access, the request is denied.
5. **Hierarchy:** Higher roles (VERIFIER, ADMIN) inherit the capabilities of lower roles (USER, VERIFIER).
6. **Audit Logging:** All administrative actions are logged with actor ID, action, and metadata.

## Testing

RBAC correctness is verified by comprehensive test suites that achieve 95%+ coverage on RBAC decision branches:

### Core Security Tests
- **[src/tests/rbac.test.ts](../src/tests/rbac.test.ts):** Core RBAC middleware tests including security header bypass prevention, property-based security tests, and authentication precedence invariants.
- **[src/tests/rbac.precedence.test.ts](../src/tests/rbac.precedence.test.ts):** Dedicated unit and integration tests to verify the authentication precedence invariant (401-before-403) across all protected routes (admin, verifier, milestones, metrics) and CORS preflight handling.

### Admin Endpoint Coverage
- **[src/tests/admin.rbac.test.ts](../src/tests/admin.rbac.test.ts):** Comprehensive admin endpoint RBAC coverage including user management, audit logs, and system overrides.

### Verifier Workflow Tests
- **[src/tests/verifier.rbac.test.ts](../src/tests/verifier.rbac.test.ts):** Verifier workflow RBAC tests covering `/api/verifications` endpoints and role hierarchy enforcement.

### Admin Verifier Management
- **[src/tests/adminVerifiers.rbac.test.ts](../src/tests/adminVerifiers.rbac.test.ts):** Complete verifier management CRUD lifecycle with RBAC enforcement for all `/api/admin/verifiers/*` endpoints.

### Test Utilities and Fixtures
- **[src/tests/helpers/rbacTestUtils.ts](../src/tests/helpers/rbacTestUtils.ts):** Standardized token generation, security bypass test cases, and validation utilities.
- **[src/tests/fixtures/rbacArbitraries.ts](../src/tests/fixtures/rbacArbitraries.ts):** Property-based test generators for comprehensive RBAC security validation.

### Security Properties Validated

The test suites validate six critical security properties:

1. **Header Isolation:** Role information is read exclusively from JWT tokens, never from request headers
2. **Admin Endpoint Access Control:** All `/api/admin/*` endpoints enforce admin-only access
3. **Verifier Endpoint Access Control:** Verifier endpoints enforce proper role hierarchy (VERIFIER + ADMIN for POST, ADMIN-only for GET)
4. **Verifier Management Access Control:** All verifier management endpoints are admin-only
5. **Authentication Precedence:** Authentication failures (401) always precede authorization failures (403)
6. **Error Envelope Consistency:** All error responses follow consistent JSON structure with proper status codes

### Security Bypass Prevention

Tests specifically validate that the following bypass attempts fail:
- Header spoofing (`x-user-role`, `x-requested-role`, etc.)
- Token manipulation (malformed, expired, wrong signature)
- JWT signature bypass attempts
- Session hijacking prevention
- Role escalation through request parameters
- Authentication header case manipulation

### Property-Based Testing

The test suite includes property-based tests with minimum 100 iterations per property to validate universal security properties across all valid inputs, providing comprehensive coverage beyond unit tests.


## Middleware Consolidation
`auth.middleware.ts` and `userAuth.ts` have been consolidated into `auth.ts`. Please import `authenticate` and `authorize` strictly from `src/middleware/auth.js`. `requireUserAuth` is deprecated and will be removed in #454.

## Abuse Detection and Anomaly Categories

Failed authentication attempts are tracked by the `security/abuse-monitor.ts` middleware and emitted as structured log events with an `AbuseCategory` discriminated union. See `src/types/security.ts` for the full type definition.

Auth-related categories:

- **`brute-force`**: Triggered when a source IP exceeds `SECURITY_FAILED_LOGIN_BURST_THRESHOLD` failed logins within `SECURITY_FAILED_LOGIN_WINDOW_MS`. Carries `failedLoginCount` and `windowMs`.

Aggregate counts are available at `GET /api/admin/abuse/category-counts` for admin users.
