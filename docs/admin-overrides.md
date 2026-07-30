# Admin Override Safeguards

This document describes the security safeguards and audit metadata collection for admin override endpoints.

## Overview

Admin override endpoints provide elevated privileges to perform critical operations like vault cancellations. These endpoints implement multiple safeguards to ensure accountability, prevent abuse, and maintain system integrity.

## Endpoint

```
POST /api/admin/overrides/vaults/:id/cancel
```

## Required Reason Codes

All admin override requests must include a valid `reasonCode` from the following list:

| Code | Description |
|------|-------------|
| `USER_REQUEST` | Cancellation requested by vault owner |
| `FRAUD_DETECTED` | Fraudulent activity detected |
| `SYSTEM_ERROR` | System malfunction requiring intervention |
| `POLICY_VIOLATION` | Violation of platform policies |
| `EMERGENCY_ADMIN_ACTION` | Urgent administrative action required |
| `COMPLIANCE_REQUIREMENT` | Regulatory or compliance obligation |
| `TESTING_CLEANUP` | Cleanup during testing (dev/staging only) |

## Request Format

```json
{
  "reasonCode": "FRAUD_DETECTED",
  "reason": "Optional human-readable description",
  "details": "Additional context (sanitized)",
  "idempotencyKey": "optional-custom-key"  // Optional, auto-generated if omitted
}
```

## Security Safeguards

### 1. RBAC Enforcement
- Only users with `ADMIN` role can access override endpoints
- Returns `403 Forbidden` for non-admin users (USER, VERIFIER roles)
- Returns `401 Unauthorized` for unauthenticated requests

### 2. Explicit Reason Codes
- All overrides require a valid `reasonCode`
- Invalid or missing reason codes return `400 Bad Request`
- Response includes the list of valid reason codes

### 3. Idempotency
- Duplicate override attempts return `409 Conflict`
- Idempotency tracked via `idempotencyKey` (explicit or auto-generated)
- Response includes original `auditLogId` and `processedAt` timestamp

### 4. PII/Secrets Sanitization
- Emails: `john@example.com` → `[REDACTED_EMAIL]`
- IP addresses: `192.168.1.1` → `[REDACTED_IP]`
- Credit cards: `1234-5678-9012-3456` → `[REDACTED_CARD]`
- SSN: `123-45-6789` → `[REDACTED_SSN]`
- Tokens/secrets: Long alphanumeric strings → `[REDACTED_TOKEN]`

## Response Format

### Success (200 OK)
```json
{
  "vault": {
    "id": "vault-id",
    "status": "cancelled",
    // ... other vault fields
  },
  "auditLogId": "audit-123456",
  "idempotencyKey": "admin-id:vault-id:cancel",
  "previousStatus": "active",
  "newStatus": "cancelled"
}
```

### Idempotent Replay (409 Conflict)
```json
{
  "error": "Override already processed - idempotent replay",
  "idempotencyKey": "admin-id:vault-id:cancel",
  "auditLogId": "audit-123456",
  "processedAt": "2026-01-01T00:00:00.000Z"
}
```

### Already Cancelled (409 Conflict)
```json
{
  "error": "Vault is already cancelled",
  "auditLogId": "audit-789012"
}
```

### Missing Reason Code (400 Bad Request)
```json
{
  "error": "Missing required field: reasonCode",
  "validReasonCodes": ["USER_REQUEST", "FRAUD_DETECTED", "..."]
}
```

## Audit Metadata

Every override operation generates a detailed audit log:

```json
{
  "id": "audit-123456",
  "actor_user_id": "admin-id",
  "action": "admin.override",
  "target_type": "vault",
  "target_id": "vault-id",
  "metadata": {
    "override_type": "vault.cancel",
    "previous_status": "active",
    "new_status": "cancelled",
    "reason_code": "FRAUD_DETECTED",
    "reason_text": "Fraud detected [REDACTED_EMAIL] reported",
    "details": "Suspicious activity from [REDACTED_IP]",
    "idempotency_key": "admin-id:vault-id:cancel",
    "admin_id": "admin-id",
    "request_context": {
      "user_agent": "Mozilla/5.0...",
      "method": "POST",
      "path": "/api/admin/overrides/vaults/vault-id/cancel"
    },
    "diff": {
      "status": {
        "before": "active",
        "after": "cancelled"
      },
      "changed_at": "2026-01-01T00:00:00.000Z"
    }
  },
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

### Metadata Fields

| Field | Description |
|-------|-------------|
| `override_type` | Type of override operation |
| `reason_code` | Categorized reason from valid codes list |
| `reason_text` | Sanitized human-readable description |
| `details` | Additional context (sanitized) |
| `idempotency_key` | Key used for duplicate detection |
| `request_context` | HTTP request metadata |
| `diff` | Before/after state comparison |

## Idempotency Behavior

1. **Explicit Key**: Client provides `idempotencyKey` in request body
2. **Auto-generated**: If omitted, key is generated as `{adminId}:{vaultId}:cancel`
3. **First Request**: Processes operation, returns 200 with `auditLogId`
4. **Duplicate Request**: Returns 409 with original `auditLogId` and `processedAt`

## State Consistency

- Attempting to cancel an already-cancelled vault returns `409` with `auditLogId`
- Non-cancellable statuses (completed, failed) return `409` with current status
- All operations are logged even when no state change occurs

## Confirmation-Token and Dual-Control Guard

Several admin operations are irreversible or high-impact enough that a single compromised admin session could cause serious damage. These operations require a **confirmation token** — a short-lived, action-scoped secret issued by a separate prepare call — before they can execute. The highest-impact operations additionally require a **second-admin approval** (dual-control) before the token can be consumed.

### Destructive Actions

| Action | Routes guarded | Dual-control by default |
|--------|---------------|------------------------|
| `horizon.cursor.reset` | `POST /api/admin/horizon/listener/reset-cursor` | No |
| `embeddings.force_resync` | `POST /api/admin/embeddings/reembed` | No |
| `user.soft_delete` | `DELETE /api/admin/users/:id` | No |
| `user.hard_delete` | `DELETE /api/admin/users/:id?hard=true` | **Yes** |

The `DUAL_CONTROL_ACTIONS` environment variable (comma-separated list) controls which actions require a second approver. Default: `user.hard_delete`.

### Confirmation-Token Flow (single-control)

```
1. Admin  →  POST /api/admin/confirm/prepare
             Body: { "action": "horizon.cursor.reset", "scope": "CCONTRACT1" }
             Response: { "tokenId": "<uuid>", "expiresAt": "...", "dualControlRequired": false }

2. Admin  →  POST /api/admin/horizon/listener/reset-cursor
             Header: x-confirmation-token: <tokenId>   (or body: { "confirmationToken": "<tokenId>" })
             → 200 OK
```

### Dual-Control Flow (second-approver required)

```
1. Admin A →  POST /api/admin/confirm/prepare
              Body: { "action": "user.hard_delete", "scope": "user-xyz" }
              Response: { "tokenId": "<uuid>", "dualControlRequired": true,
                          "approveUrl": "/api/admin/confirm/approve/<uuid>" }

2. Admin B →  POST /api/admin/confirm/approve/<uuid>
              Response: { "tokenId": "<uuid>", "approvedBy": "admin-B-id", "approvedAt": "..." }
              (Admin B must be a different admin from Admin A — self-approval is rejected)

3. Admin A →  DELETE /api/admin/users/user-xyz?hard=true
              Header: x-confirmation-token: <uuid>
              → 200 OK
```

### Prepare Endpoint

```
POST /api/admin/confirm/prepare
Authorization: Bearer <admin-token>

Body:
{
  "action": "user.hard_delete",   // required; one of VALID_DESTRUCTIVE_ACTIONS
  "scope": "user-id-or-resource"  // optional; stored for audit trail
}

Response 201:
{
  "tokenId": "<uuid>",
  "action": "user.hard_delete",
  "scope": "user-id-or-resource",
  "expiresAt": "2026-06-28T00:15:00.000Z",
  "dualControlRequired": true,
  "approveUrl": "/api/admin/confirm/approve/<uuid>"
}
```

### Approve Endpoint (dual-control only)

```
POST /api/admin/confirm/approve/:tokenId
Authorization: Bearer <second-admin-token>

Response 200:
{
  "tokenId": "<uuid>",
  "action": "user.hard_delete",
  "approvedBy": "<admin-2-user-id>",
  "approvedAt": "2026-06-28T00:02:00.000Z"
}
```

### Error responses

| Status | Reason |
|--------|--------|
| 400 | Missing or invalid `action` on prepare |
| 403 | No confirmation token supplied to a guarded route |
| 403 | Token is invalid, expired, wrong-scope, or already used |
| 404 | Token not found on approve |
| 409 | Self-approval, double-approval, or approve on non-dual-control action |

### Audit trail

Every step is recorded in the immutable audit log chain:

| Event | `action` field | Actor |
|-------|---------------|-------|
| Token prepared | `admin.destructive_action.prepared` | Admin who prepared |
| Token approved | `admin.destructive_action.approved` | Second admin who approved |
| Destructive action executed | route-specific (e.g. `user.hard_delete`) | Admin who executed |

### Token properties

- **Action-scoped**: A token for `horizon.cursor.reset` is rejected on `embeddings.force_resync` and vice-versa.
- **User-bound**: Only the admin who prepared the token can consume it.
- **Single-use**: Once consumed the token is deleted; replay attempts are rejected.
- **Short-lived**: 5 minutes for single-control actions; 15 minutes for dual-control (to allow the second admin time to review and approve).
- **Self-approval prohibited**: The approver must be a different admin from the preparer.

## Testing

Run the override-specific tests:

```bash
# Dual-control and confirmation-token tests
npm test -- src/tests/admin.dualControl.test.ts

# All admin tests including override tests
npm test -- tests/admin.test.ts

# Run RBAC security tests
npm test -- src/tests/admin.rbac.test.ts

# Run specific override test pattern
npm test -- --testNamePattern="Admin Override"
```

## Implementation Notes

- In-memory idempotency tracking uses `Map` (use Redis in production)
- Confirmation tokens use the same in-memory `Map` pattern as step-up nonces
- Audit logs are stored in-memory for development; use persistent store in production
- All metadata keys are normalized to snake_case
- Nested objects in metadata are recursively sanitized
