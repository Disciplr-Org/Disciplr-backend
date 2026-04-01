# Vault API Documentation

## Overview

API endpoints for vault lifecycle management including creation, retrieval, cancellation, and user-specific vault queries.

## Authentication

All endpoints require:
- `Authorization: Bearer <jwt_token>` header

## Endpoints

### GET /api/vaults

List vaults with pagination, filtering, and sorting.

**Query Parameters:**
- `status`: Filter by status (active, completed, failed, cancelled)
- `creator`: Filter by creator address
- `sort`: Sort field (createdAt, amount, endTimestamp, status)
- `sortOrder`: asc or desc
- `page`: Page number
- `limit`: Results per page

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "creator": "G...",
      "amount": "1000.0000000",
      "status": "active",
      "startTimestamp": "2026-02-26T12:00:00Z",
      "endTimestamp": "2026-03-26T12:00:00Z",
      "successDestination": "G...",
      "failureDestination": "G...",
      "createdAt": "2026-02-26T12:00:00Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 100,
    "hasMore": true
  }
}
```

### POST /api/vaults

Create a new vault.

**Body:**
```json
{
  "creator": "GABC...",
  "amount": "1000.0000000",
  "endTimestamp": "2026-03-26T12:00:00Z",
  "successDestination": "G...",
  "failureDestination": "G...",
  "milestoneHash": "hash123",
  "verifierAddress": "G...",
  "contractId": "contract123"
}
```

**Response:** `201 Created`
```json
{
  "id": "uuid",
  "creator": "G...",
  "amount": "1000.0000000",
  "status": "active",
  "startTimestamp": "2026-02-26T12:00:00Z",
  "endTimestamp": "2026-03-26T12:00:00Z",
  "successDestination": "G...",
  "failureDestination": "G...",
  "createdAt": "2026-02-26T12:00:00Z"
}
```

### GET /api/vaults/:id

Get vault by ID. Tries database first, falls back to in-memory storage.

**Response:**
```json
{
  "id": "uuid",
  "creator": "G...",
  "amount": "1000.0000000",
  "status": "active",
  "startTimestamp": "2026-02-26T12:00:00Z",
  "endTimestamp": "2026-03-26T12:00:00Z",
  "successDestination": "G...",
  "failureDestination": "G...",
  "createdAt": "2026-02-26T12:00:00Z"
}
```

### POST /api/vaults/:id/cancel

Cancel a vault. Only the creator or an admin can cancel.

**Response:** `200 OK`
```json
{
  "message": "Vault cancelled",
  "id": "uuid"
}
```

### GET /api/vaults/user/:address

Get all vaults for a specific user address.

**Response:**
```json
[
  {
    "id": "uuid",
    "creator": "G...",
    "amount": "1000.0000000",
    "status": "active",
    ...
  }
]
```

## Error Responses

```json
{"error": "Descriptive message"}
```

Status codes: 200, 201, 400, 401, 403, 404, 500

## Security

- JWT authentication required for all endpoints
- Authorization checks for vault cancellation (creator or admin only)
- Input validation for all parameters
- Idempotency support for vault creation

## Testing

Run tests: `npm run test:vaults`
