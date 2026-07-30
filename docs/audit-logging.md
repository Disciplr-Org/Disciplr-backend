# Audit Logging Documentation

## Overview

The Disciplr backend implements comprehensive audit logging for tracking important system events, particularly those related to vault operations and user actions.

## Audit Log Structure

Each audit log entry contains:

```typescript
interface AuditLog {
  id: string
  actor_user_id: string
  organization_id?: string
  action: string
  target_type: string
  target_id: string
  metadata: Record<string, unknown>
  created_at: string
  prev_hash?: string
  row_hash?: string
}
```

## Audit Events

### Vault Operations

#### vault.created
Triggered when a new vault is created.

**Metadata:**
- `creator`: Vault creator address
- `amount`: Vault amount

**Example:**
```json
{
  "id": "audit-1643212345-abc123",
  "actor_user_id": "user123",
  "action": "vault.created",
  "target_type": "vault",
  "target_id": "vault-uuid",
  "metadata": {
    "creator": "GABC...",
    "amount": "1000",
    "admin_id": "user123"
  },
  "created_at": "2026-04-25T08:52:00.000Z"
}
```

#### vault.cancelled
Triggered when a vault is cancelled.

**Metadata:**
- `previous_status`: Vault status before cancellation
- `new_status`: Always set to "cancelled"
- `reason`: Cancellation reason (optional)
- `cancelled_by`: "creator" or "admin"
- `creator`: Original vault creator
- `amount`: Vault amount

**Example:**
```json
{
  "id": "audit-1643212345-def456",
  "actor_user_id": "admin-user",
  "action": "vault.cancelled",
  "target_type": "vault",
  "target_id": "vault-uuid",
  "metadata": {
    "previous_status": "active",
    "new_status": "cancelled",
    "reason": "User requested cancellation",
    "cancelled_by": "admin",
    "creator": "GABC...",
    "amount": "1000",
    "admin_id": "admin-user"
  },
  "created_at": "2026-04-25T08:52:00.000Z"
}
```

## Security Considerations

### Actor Identification
- Audit logs always use `req.user.userId` as the primary actor identifier
- Actor information is never taken from untrusted headers when `req.user` is available
- For admin actions, the admin ID is automatically included in metadata

### Data Sanitization
- Sensitive data (passwords, tokens, emails, IPs) is automatically redacted
- Stellar addresses are preserved as they are necessary for audit trails
- All metadata keys are normalized to snake_case

### Integrity Hash Chain

Each persisted audit row carries a SHA-256 hash chain:

- `prev_hash`: the previous audit row hash in the same `organization_id` chain, or 64 zeroes for the first row.
- `row_hash`: `sha256({ prev_hash, canonical_row })`.
- `canonical_row`: stable JSON containing `id`, `actor_user_id`, `organization_id`, `action`, `target_type`, `target_id`, `metadata`, and normalized `created_at`.

Verification loads rows for one organization ordered by `(created_at, id)`, recomputes each `row_hash`, and confirms each `prev_hash` equals the prior row hash. Altered rows, removed middle rows, and reordered rows are reported as integrity failures.

## API Access

### List Audit Logs
```http
GET /api/audit-logs?actor_user_id=user123&action=vault.cancelled&limit=50
```

**Query Parameters:**
- `actor_user_id`: Filter by actor
- `action`: Filter by action type
- `target_type`: Filter by target type
- `target_id`: Filter by target ID
- `limit`: Maximum number of results (default: 100)

### Get Audit Log by ID
```http
GET /api/audit-logs/{audit_id}
```

### Verify Audit Log Chain
```http
GET /api/admin/audit-logs/organizations/{organization_id}/verify
POST /api/admin/audit-logs/verify
```

`POST /api/admin/audit-logs/verify` accepts an optional `organization_id` in the JSON body. If omitted, it verifies the legacy null-organization chain.

### Export Tenant Audit Trail
```http
GET /api/admin/audit-logs/organizations/{organization_id}/export
```

The export is scoped to the requested tenant and returns redacted audit rows plus a proof section containing each row `id`, `prev_hash`, and `row_hash`. Export redaction uses the shared privacy redactor so field names listed in `PRIVACY.md`, email-shaped values, JWTs, and nested sensitive values are not emitted.

## Implementation Notes

### Creating Audit Logs
```typescript
import { createAuditLog } from '../lib/audit-logs.js'

createAuditLog({
  actor_user_id: req.user.userId,
  action: 'vault.cancelled',
  target_type: 'vault',
  target_id: vaultId,
  metadata: {
    previous_status: 'active',
    new_status: 'cancelled',
    reason: 'User requested',
    cancelled_by: 'creator',
    creator: vault.creator,
    amount: vault.amount,
  },
})
```

### Testing
- Use `clearAuditLogs()` for test isolation
- Audit logs are stored in-memory during testing
- Test coverage should verify both successful operations and authorization failures

### Performance and Indexing

For admin UI access patterns that scope queries to a specific organization and list recent events, the recommended access pattern is:

- WHERE organization_id = $ORG_ID
- ORDER BY created_at DESC
- LIMIT $N OFFSET $M

This pattern is supported by a composite index on `(organization_id, created_at DESC)` which ensures the database can satisfy the ordered limit efficiently without a filesort.

Example `EXPLAIN ANALYZE` output (captured during load testing):

```
Limit  (cost=0.14..12.50 rows=50 width=256) (actual time=0.12..1.23 rows=50 loops=1)
  ->  Index Scan using idx_audit_logs_organization_created on audit_logs  (cost=0.14..2534.50 rows=1000 width=256) (actual time=0.11..1.20 rows=50 loops=1)
        Index Cond: (organization_id = '00000000-0000-0000-0000-000000000000'::uuid)
Planning Time: 0.20 ms
Execution Time: 1.35 ms
```

If your production dataset grows large, prefer paginating with `LIMIT` + `OFFSET` or use cursor-based pagination on `(created_at, id)` to avoid deep OFFSET scans.

## Best Practices

1. **Always include audit logs for state-changing operations**
2. **Use consistent action naming: `resource.action` format**
3. **Include relevant metadata for context and debugging**
4. **Never log sensitive information (PII, credentials)**
5. **Test audit log creation in unit and integration tests**
6. **Ensure actor identification is secure and consistent**

## Compliance

Audit logs support:
- **Accountability**: Track who performed what actions
- **Forensics**: Debug issues and investigate incidents
- **Compliance**: Meet regulatory requirements for audit trails
- **Security**: Monitor for suspicious activity patterns
