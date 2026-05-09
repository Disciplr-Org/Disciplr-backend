# Audit Logs System

## Overview

The Disciplr backend implements a comprehensive audit logging system that tracks all significant actions performed within the application. This system ensures compliance, security monitoring, and traceability of administrative and user actions.

## Architecture

### Database Schema

Audit logs are stored in the `audit_logs` table with the following structure:

```sql
CREATE TABLE audit_logs (
  id STRING PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id STRING NOT NULL,
  action STRING NOT NULL,
  target_type STRING NOT NULL,
  target_id STRING NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### Performance Indexes

The following indexes are implemented for optimal query performance:

- `idx_audit_logs_actor_user_id` - Filter by actor
- `idx_audit_logs_action` - Filter by action type
- `idx_audit_logs_target_type` - Filter by target type
- `idx_audit_logs_target_id` - Filter by target ID
- `idx_audit_logs_created_at` - Sort by timestamp
- `idx_audit_logs_actor_created` - Composite: actor + timestamp
- `idx_audit_logs_action_created` - Composite: action + timestamp
- `idx_audit_logs_target` - Composite: target type + target ID

## API Endpoints

### GET /api/admin/audit-logs

Retrieves audit logs with filtering and pagination support.

**Authentication:** Required (Admin only)

**Query Parameters:**
- `actor_user_id` (string, optional) - Filter by user who performed the action
- `action` (string, optional) - Filter by action type
- `target_type` (string, optional) - Filter by target entity type
- `target_id` (string, optional) - Filter by target entity ID
- `limit` (number, optional, default: 100) - Maximum number of results to return
- `offset` (number, optional, default: 0) - Number of results to skip

**Response:**
```json
{
  "audit_logs": [
    {
      "id": "audit-1648765432-abc123",
      "actor_user_id": "admin-123",
      "action": "user.role.update",
      "target_type": "user",
      "target_id": "user-456",
      "metadata": {
        "admin_id": "admin-123",
        "old_role": "USER",
        "new_role": "ADMIN"
      },
      "created_at": "2024-04-28T13:45:32.123Z"
    }
  ],
  "count": 1,
  "total": 150,
  "limit": 100,
  "offset": 0,
  "has_more": true
}
```

### GET /api/admin/audit-logs/:id

Retrieves a specific audit log by ID.

**Authentication:** Required (Admin only)

**Response:**
```json
{
  "id": "audit-1648765432-abc123",
  "actor_user_id": "admin-123",
  "action": "user.role.update",
  "target_type": "user",
  "target_id": "user-456",
  "metadata": {
    "admin_id": "admin-123",
    "old_role": "USER",
    "new_role": "ADMIN"
  },
  "created_at": "2024-04-28T13:45:32.123Z"
}
```

## Security Features

### Metadata Sanitization

The audit system automatically sanitizes metadata to prevent sensitive information leakage:

- **Redacted Fields:** Passwords, tokens, emails, IP addresses, SSNs, credit card numbers
- **Pattern Detection:** Automatically detects and redacts potential secrets
- **Field Normalization:** Converts field names to snake_case for consistency

### Example Sanitization

```javascript
// Input metadata
{
  "userEmail": "user@example.com",
  "password": "secret123",
  "apiKey": "sk_live_1234567890abcdef",
  "userRole": "ADMIN",
  "clientIP": "192.168.1.1"
}

// Sanitized output stored in audit log
{
  "user_email": "[redacted]",
  "user_role": "ADMIN"
}
```

## Common Action Types

### User Management
- `user.role.update` - User role changed
- `user.status.update` - User status changed
- `user.soft_delete` - User soft deleted
- `user.hard_delete` - User permanently deleted
- `user.restore` - User restored from deletion

### Authentication
- `auth.login` - User login
- `auth.logout` - User logout
- `auth.failed_login` - Failed login attempt

### Vault Management
- `vault.created` - Vault created
- `vault.updated` - Vault modified
- `vault.cancelled` - Vault cancelled

### Administrative
- `admin.override` - Administrative override action
- `admin.metrics.access` - Database metrics accessed

## Usage Examples

### Filtering by User
```bash
curl -H "Authorization: Bearer <token>" \
  "https://api.disciplr.com/api/admin/audit-logs?actor_user_id=admin-123"
```

### Filtering by Action
```bash
curl -H "Authorization: Bearer <token>" \
  "https://api.disciplr.com/api/admin/audit-logs?action=user.role.update"
```

### Pagination
```bash
curl -H "Authorization: Bearer <token>" \
  "https://api.disciplr.com/api/admin/audit-logs?limit=50&offset=100"
```

### Combined Filters
```bash
curl -H "Authorization: Bearer <token>" \
  "https://api.disciplr.com/api/admin/audit-logs?action=admin.override&limit=20"
```

## Performance Considerations

### Query Optimization
- Use specific filters when possible to leverage indexes
- Limit result sets for better performance
- Consider pagination for large datasets

### Index Usage
- Single filters use dedicated indexes
- Combined filters use composite indexes
- Timestamp sorting uses `created_at` index

### Recommended Query Patterns
```sql
-- Efficient: Uses composite index
SELECT * FROM audit_logs 
WHERE actor_user_id = 'admin-123' 
ORDER BY created_at DESC 
LIMIT 100;

-- Efficient: Uses action + timestamp composite index
SELECT * FROM audit_logs 
WHERE action = 'user.role.update' 
ORDER BY created_at DESC 
LIMIT 50;
```

## Testing

### Running Tests
```bash
# Run audit log core tests
npm test -- audit-logs.test.ts

# Run admin route tests
npm test -- admin.auditlogs.test.ts
```

### Test Coverage
- Core audit log functionality
- Metadata sanitization
- Database operations
- API endpoint behavior
- Authentication and authorization
- Pagination and filtering
- Error handling

## Migration

### Database Migration
The audit logs system uses Knex migrations. To apply the migration:

```bash
npm run migrate:latest
```

### Migration File
- Location: `db/migrations/20260428131106_create_audit_logs_table.cjs`
- Creates table with all necessary indexes
- Includes comments for documentation

## Compliance

### Data Retention
- Audit logs are retained indefinitely for compliance
- Consider implementing data retention policies based on regulatory requirements

### Access Control
- Only users with `ADMIN` role can access audit logs
- All access is logged and audited

### Integrity
- Audit logs are immutable once created
- No update or delete operations are exposed
- All entries include timestamps and actor information

## Troubleshooting

### Common Issues

#### Slow Queries
- Ensure appropriate filters are used
- Check index usage with `EXPLAIN ANALYZE`
- Consider adding additional composite indexes for specific query patterns

#### Missing Audit Entries
- Verify `createAuditLog()` calls are awaited
- Check for errors in application logs
- Ensure database connection is healthy

#### Large Metadata Objects
- Metadata is stored as JSONB with size limits
- Consider splitting large objects into multiple entries
- Monitor database storage usage

### Monitoring
- Monitor audit log table growth
- Track query performance metrics
- Set up alerts for failed audit log creation
