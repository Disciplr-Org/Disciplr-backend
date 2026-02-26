# Admin User Management API Documentation

## Overview

Admin-only endpoints for managing user accounts with authentication, audit logging, and comprehensive filtering.

## Authentication

All endpoints require:
- `Authorization: Bearer <jwt_token>` header
- User role: `ADMIN`
- Valid JWT with `userId` and `role` claims

## Endpoints

### GET /api/admin/users

List users with pagination and filters.

**Query Parameters:**
- `role`: USER|VERIFIER|ADMIN (optional)
- `status`: ACTIVE|INACTIVE|SUSPENDED (optional) 
- `search`: email/ID search (optional)
- `limit`: results per page (default: 20)
- `offset`: results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "role": "USER",
      "status": "ACTIVE",
      "createdAt": "2026-02-26T12:00:00Z",
      "updatedAt": "2026-02-26T12:00:00Z",
      "lastLoginAt": "2026-02-26T11:30:00Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 150,
    "hasMore": true
  }
}
```

### PATCH /api/admin/users/:id/role

Update user role with audit logging.

**Body:**
```json
{"role": "VERIFIER"}
```

**Valid roles:** USER, VERIFIER, ADMIN

**Response:**
```json
{
  "user": {...},
  "auditLogId": "audit-1234567890-abcdef"
}
```

### PATCH /api/admin/users/:id/status

Update user status with audit logging.

**Body:**
```json
{"status": "SUSPENDED"}
```

**Valid statuses:** ACTIVE, INACTIVE, SUSPENDED

**Response:**
```json
{
  "user": {...},
  "auditLogId": "audit-1234567890-xyz123"
}
```

## Security

- JWT authentication required
- Admin role verification
- Input validation for all parameters
- Comprehensive audit logging
- Tamper-proof audit trails

## Error Responses

```json
{"error": "Descriptive message"}
```

Status codes: 200, 400, 401, 403, 404, 500

## Testing

Run tests: `npm test src/routes/admin.test.ts`
