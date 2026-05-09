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
  "amount": "1000",
  "startDate": "2030-01-01T00:00:00.000Z",
  "endDate": "2030-06-01T00:00:00.000Z",
  "verifier": "GABC...",
  "destinations": {
    "success": "G...",
    "failure": "G..."
  },
  "milestones": [
    {
      "title": "Milestone title",
      "description": "Optional description",
      "dueDate": "2030-02-01T00:00:00.000Z",
      "amount": "500"
    }
  ],
  "creator": "GABC...", // Optional
  "onChain": {
    // Optional
    "mode": "build", // "build" or "submit", defaults to "build"
    "contractId": "contract123",
    "networkPassphrase": "test-network",
    "sourceAccount": "G..."
  }
}
```

**Validation Constraints:**

#### Amount Validation

- **Type**: String or number (numbers are converted to strings)
- **Range**: 1 to 1,000,000,000 (inclusive)
- **Format**: Must be a positive finite number
- **Invalid examples**: "0", "-100", "abc", "Infinity", "NaN"

#### Stellar Address Validation

- **Format**: `G` followed by 55 characters from A-Z and 2-7
- **Case sensitive**: Must be uppercase
- **Example**: `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF`

#### Timestamp Validation

- **Format**: ISO 8601 timestamp
- **Required fields**: startDate, endDate, milestone.dueDate
- **Date relationships**:
  - endDate must be strictly after startDate
  - milestone.dueDate must be >= startDate
- **Invalid examples**: "invalid-date", "2023-13-01T00:00:00.000Z"

#### Milestones Validation

- **Array**: Must contain at least 1 milestone
- **Title**: Required, non-empty string (whitespace-only strings are rejected)
- **Description**: Optional string
- **Amount**: Same validation rules as vault amount
- **Total constraint**: Sum of all milestone amounts must not exceed vault amount

#### Security Constraints

- **Payload size**: Limited to prevent DoS attacks
- **Processing time**: Validation completes within 5 seconds for large payloads
- **Type safety**: Strict type validation with no prototype pollution
- **Malicious input**: Rejected quickly with consistent error format

#### Error Response Format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "fields": [
      {
        "path": "amount",
        "message": "must be between 1 and 1,000,000,000"
      },
      {
        "path": "verifier",
        "message": "must be a valid Stellar public key"
      }
    ]
  }
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

**Body:**

```json
{
  "reason": "Optional cancellation reason"
}
```

**Response:** `200 OK`

```json
{
  "message": "Vault cancelled",
  "id": "uuid"
}
```

**Audit Logging:**
This endpoint creates an audit log entry with:

- Action: `vault.cancelled`
- Target: `vault:{vault_id}`
- Metadata:
  - `previous_status`: Vault status before cancellation
  - `new_status`: Always set to "cancelled"
  - `reason`: Cancellation reason (or default "User requested cancellation")
  - `cancelled_by`: "creator" or "admin"
  - `creator`: Original vault creator
  - `amount`: Vault amount

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
{ "error": "Descriptive message" }
```

Status codes: 200, 201, 400, 401, 403, 404, 500

## Security

- JWT authentication required for all endpoints
- Authorization checks for vault cancellation (creator or admin only)
- Input validation for all parameters
- Idempotency support for vault creation

## Testing

Run tests: `npm run test:vaults`
