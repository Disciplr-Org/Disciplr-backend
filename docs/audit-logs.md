# Audit Logs Implementation

This document describes the persistent audit log storage implementation for the Disciplr backend, including database schema, API endpoints, security considerations, and performance optimizations.

## Overview

The audit log system has been migrated from in-memory storage to persistent PostgreSQL storage with proper indexing for efficient admin queries. The system captures all important user actions with metadata while ensuring security and performance.

## Database Schema

### AuditLog Model

```prisma
model AuditLog {
  id           String   @id @default(cuid())
  actorUserId  String
  action       String
  resource     String?
  resourceId   String?
  metadata     Json?
  ipAddress    String?
  userAgent    String?
  createdAt    DateTime @default(now())

  actor User @relation(fields: [actorUserId], references: [id], onDelete: Cascade)

  @@index([actorUserId])
  @@index([action])
  @@index([createdAt])
  @@index([actorUserId, createdAt])
  @@index([action, createdAt])
  @@map("audit_logs")
}
```

### Performance Indexes

The following indexes have been created to optimize common query patterns:

1. **`actorUserId`** - Fast filtering by user
2. **`action`** - Fast filtering by action type
3. **`createdAt`** - Fast sorting and date range queries
4. **`actorUserId, createdAt`** - Composite index for user activity over time
5. **`action, createdAt`** - Composite index for action trends over time

## API Endpoints

### GET /api/admin/audit-logs

Retrieve paginated audit logs with filtering options.

**Authentication:** Admin role required

**Query Parameters:**
- `actorUserId` (string, optional) - Filter by user ID
- `action` (string, optional) - Filter by action type
- `resource` (string, optional) - Filter by resource type
- `startDate` (ISO date, optional) - Filter logs from this date
- `endDate` (ISO date, optional) - Filter logs until this date
- `page` (number, default: 1) - Page number for pagination
- `limit` (number, default: 50, max: 100) - Items per page

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "audit_123",
      "actorUserId": "user_456",
      "action": "USER_LOGIN",
      "resource": "auth",
      "resourceId": null,
      "metadata": {
        "method": "POST",
        "path": "/api/auth/login",
        "statusCode": 200
      },
      "ipAddress": "127.0.0.1",
      "userAgent": "Mozilla/5.0...",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "actor": {
        "id": "user_456",
        "email": "user@example.com",
        "role": "user"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1250,
    "totalPages": 25
  }
}
```

### GET /api/admin/audit-logs/:id

Retrieve a specific audit log by ID.

**Authentication:** Admin role required

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "audit_123",
    "actorUserId": "user_456",
    "action": "USER_LOGIN",
    "resource": "auth",
    "resourceId": null,
    "metadata": {
      "method": "POST",
      "path": "/api/auth/login",
      "statusCode": 200
    },
    "ipAddress": "127.0.0.1",
    "userAgent": "Mozilla/5.0...",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "actor": {
      "id": "user_456",
      "email": "user@example.com",
      "role": "user"
    }
  }
}
```

## Usage Examples

### Logging Audit Events

```typescript
import { logAuditEvent } from '../lib/audit-logs';

// Log a user login
await logAuditEvent({
  actorUserId: user.id,
  action: 'USER_LOGIN',
  resource: 'auth',
  metadata: {
    method: 'POST',
    path: '/api/auth/login',
    statusCode: 200
  },
  ipAddress: req.ip,
  userAgent: req.get('User-Agent')
});

// Log a profile update
await logAuditEvent({
  actorUserId: user.id,
  action: 'PROFILE_UPDATE',
  resource: 'user',
  resourceId: user.id,
  metadata: {
    updatedFields: ['email', 'name'],
    previousValues: { email: 'old@example.com' }
  }
});
```

### Using Middleware

```typescript
import { auditLogger } from '../lib/audit-logs';

// Apply to routes
router.post('/login', auditLogger('USER_LOGIN', 'auth'), loginHandler);
router.put('/users/:id', auditLogger('PROFILE_UPDATE', 'user'), updateProfile);
router.delete('/posts/:id', auditLogger('POST_DELETE', 'post'), deletePost);
```

## Security Considerations

### Metadata Security

- **Never store secrets** in metadata (passwords, tokens, API keys)
- **Sanitize sensitive data** before logging
- **Use field-level filtering** to exclude sensitive information

```typescript
// ✅ Good - Safe metadata
metadata: {
  userId: user.id,
  email: user.email,
  action: 'password_changed',
  timestamp: new Date().toISOString()
}

// ❌ Bad - Contains secrets
metadata: {
  password: 'plaintext_password',  // NEVER log passwords
  token: 'secret_token',           // NEVER log tokens
  apiKey: 'secret_api_key'         // NEVER log API keys
}
```

### Access Control

- **Admin-only access** to audit log endpoints
- **JWT authentication** required for all endpoints
- **Role-based authorization** enforced in middleware

### Data Privacy

- **IP addresses** are logged for security auditing
- **User agents** are logged for context
- **Personal data** is minimized and only accessible to admins

## Performance Optimization

### Query Performance

The implementation uses several optimization strategies:

1. **Database Indexes** - All common filter patterns are indexed
2. **Pagination** - Limits result sets to max 100 items
3. **Efficient Queries** - Uses Prisma's optimized query builder
4. **Selective Loading** - Only includes necessary related data

### Query Examples with Index Usage

```sql
-- Uses actorUserId index
SELECT * FROM audit_logs WHERE actorUserId = 'user_123';

-- Uses (actorUserId, createdAt) composite index
SELECT * FROM audit_logs 
WHERE actorUserId = 'user_123' 
AND createdAt >= '2024-01-01' 
ORDER BY createdAt DESC;

-- Uses (action, createdAt) composite index
SELECT * FROM audit_logs 
WHERE action = 'USER_LOGIN' 
AND createdAt >= '2024-01-01' 
ORDER BY createdAt DESC;
```

### Performance Benchmarks

Expected query performance with proper indexing:

- **Simple filter queries**: < 50ms
- **Date range queries**: < 100ms  
- **Composite filter queries**: < 150ms
- **Pagination queries**: < 200ms

## Testing

### Test Coverage

The implementation includes comprehensive tests covering:

- **Unit tests** for audit log functions
- **Integration tests** for API endpoints
- **Security tests** for authorization
- **Performance tests** for query efficiency
- **Edge case tests** for error handling

### Running Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test audit-logs.test.ts
```

### Test Database

Tests use a separate PostgreSQL database to avoid affecting production data:

```bash
# Set up test database
createdb disciplr_test

# Run tests with test database
DATABASE_URL="postgresql://test:test@localhost:5432/disciplr_test" npm test
```

## Migration Guide

### From In-Memory to Persistent Storage

1. **Backup existing data** if needed
2. **Run database migration**: `npm run db:migrate`
3. **Update application code** to use new functions
4. **Deploy with zero downtime** using blue-green deployment
5. **Verify functionality** with test suite

### Rollback Plan

If issues arise:

1. **Stop application** to prevent data loss
2. **Restore database** from backup
3. **Revert code** to previous version
4. **Verify functionality** before going live

## Monitoring and Maintenance

### Log Retention

- **Default retention**: 1 year
- **Archive strategy**: Move old logs to cold storage
- **Cleanup job**: Scheduled task to remove old logs

### Monitoring Metrics

- **Query performance** - Track slow queries
- **Storage usage** - Monitor database size
- **Error rates** - Track failed audit log writes
- **Access patterns** - Monitor admin endpoint usage

### Alerts

Set up alerts for:

- **High query latency** (> 500ms)
- **Failed audit writes** (> 1% error rate)
- **Storage threshold** (> 80% capacity)
- **Unauthorized access attempts**

## Future Enhancements

### Planned Features

1. **Real-time streaming** - WebSocket support for live audit feeds
2. **Advanced filtering** - More complex query capabilities
3. **Export functionality** - CSV/JSON export for compliance
4. **Audit log analytics** - Dashboard with insights
5. **Compliance reports** - Automated report generation

### Scalability Considerations

1. **Read replicas** - Separate read queries from writes
2. **Partitioning** - Time-based table partitioning
3. **Caching** - Redis cache for frequent queries
4. **Archiving** - Move old data to cheaper storage

## Troubleshooting

### Common Issues

1. **Slow queries** - Check index usage with EXPLAIN ANALYZE
2. **Missing logs** - Verify audit middleware is applied
3. **Permission errors** - Check user roles and JWT tokens
4. **Database connection** - Verify DATABASE_URL configuration

### Debug Commands

```sql
-- Check if indexes are being used
EXPLAIN ANALYZE SELECT * FROM audit_logs WHERE actorUserId = 'user_123';

-- Check table size
SELECT pg_size_pretty(pg_total_relation_size('audit_logs'));

-- Check index usage
SELECT * FROM pg_stat_user_indexes WHERE relname = 'audit_logs';
```

## Support

For issues or questions about the audit log implementation:

1. **Check this documentation** first
2. **Review test cases** for usage examples
3. **Check GitHub issues** for known problems
4. **Contact the development team** for additional support
