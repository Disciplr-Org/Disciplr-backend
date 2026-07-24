# API Patterns Documentation

This document describes the consistent patterns used across the Disciplr API, including list endpoint contracts, pagination strategies, and query parameter handling.

## Cursor Pagination

Transaction endpoints support cursor-based pagination.

Example:

GET /api/transactions?limit=20&cursor=<opaque_cursor>

Response:

{
  "pagination": {
    "limit": 20,
    "cursor": "...",
    "next_cursor": "...",
    "has_more": true
  }
}

Notes:
- Cursors are opaque base64url encoded values
- Ordering uses stellar_timestamp + id for stability
- Clients should only use next_cursor returned by the API

## List Endpoint Contract

All list endpoints in the API share a consistent query contract for pagination, sorting, and filtering.

### Endpoints Covered

- `GET /api/vaults` - List vaults with offset pagination
- `GET /api/transactions` - List transactions with cursor pagination
- `GET /api/transactions/vault/:vaultId` - List vault transactions with cursor pagination
- `GET /api/analytics/milestones/trends` - Analytics with date range filtering
- `GET /api/organizations/:orgId/vaults` - Org-scoped vault lists

### Common Query Parameters

#### Pagination

**Offset Pagination** (used by `/api/vaults`):

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number (1-indexed) |
| `pageSize` | integer | 20 | Items per page (max 100) |

**Cursor Pagination** (used by `/api/transactions`):

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cursor` | string | - | Opaque cursor for next page |
| `limit` | integer | 20 | Items per page (max 100) |

#### Sorting

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sortBy` | string | - | Field to sort by (endpoint-specific) |
| `sortOrder` | string | `asc` | Sort direction: `asc` or `desc` |

**Valid sort fields by endpoint:**

- `/api/vaults`: `createdAt`, `amount`, `endTimestamp`, `status`
- `/api/transactions`: `created_at`, `stellar_timestamp`, `amount`, `type`, `stellar_ledger`
- `/api/transactions/vault/:vaultId`: `created_at`, `stellar_timestamp`, `amount`, `type`

#### Filtering

Filter parameters are endpoint-specific. Invalid filter parameters are silently ignored.

**Vaults filtering:**
- `status` - Filter by vault status (active, completed, cancelled)
- `creator` - Filter by creator address

**Transactions filtering:**
- `type` - Filter by transaction type
- `vault_id` - Filter by vault ID
- `date_from` - Filter by start date (ISO 8601)
- `date_to` - Filter by end date (ISO 8601)
- `amount_min` - Filter by minimum amount
- `amount_max` - Filter by maximum amount

### Response Format

#### Offset Pagination Response

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 150,
    "totalPages": 8,
    "hasNext": true,
    "hasPrev": false
  }
}
```

#### Cursor Pagination Response

```json
{
  "data": [...],
  "pagination": {
    "limit": 20,
    "cursor": "eyJ0aW1lc3RhbXAiOiIyMDI1LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InR4LTEyMyJ9",
    "next_cursor": "eyJ0aW1lc3RhbXAiOiIyMDI1LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InR4LTEyNCJ9",
    "has_more": true,
    "count": 20
  }
}
```

### Error Responses

Invalid query parameters return 400 with details:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid sort field. Allowed fields: created_at, stellar_timestamp, amount, type, stellar_ledger"
  }
}
```

Invalid cursor returns:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid cursor"
  }
}
```

## Analytics-Specific Patterns

Analytics endpoints use date range filtering and grouping rather than standard pagination.

### Date Range Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | ISO 8601 datetime | Yes | Start of date range |
| `to` | ISO 8601 datetime | Yes | End of date range |
| `groupBy` | string | No | Grouping: `day` or `week` (default: `day`) |

### Example Request

```
GET /api/analytics/milestones/trends?from=2025-01-01T00:00:00.000Z&to=2025-01-31T23:59:59.999Z&groupBy=week
```

### Response Format

```json
{
  "buckets": [
    {
      "bucketStart": "2025-01-01T00:00:00.000Z",
      "bucketEnd": "2025-01-07T23:59:59.999Z",
      "total": 10,
      "successes": 7,
      "failures": 3
    }
  ]
}
```

## Security Considerations

### Tenant Isolation

All list endpoints enforce tenant isolation:
- Vaults are filtered by authenticated user
- Transactions are filtered by user_id
- Analytics only return data for the specified userId parameter

### Field Filtering

- Sort fields are whitelisted per endpoint
- Attempting to sort by non-allowed fields returns 400
- Internal fields (user_id, org_id, etc.) are never exposed as sort options

### Authentication

All list endpoints require authentication:
- Most use JWT Bearer tokens
- Analytics endpoints accept API keys via `x-api-key` header

## Usage Examples

### Paginating Through Vaults

```bash
# Get first page
curl -H "Authorization: Bearer $TOKEN" \
  "/api/vaults?page=1&pageSize=10"

# Get next page
curl -H "Authorization: Bearer $TOKEN" \
  "/api/vaults?page=2&pageSize=10"
```

### Sorting Transactions

```bash
# Newest transactions first
curl -H "x-user-id: $USER_ID" \
  "/api/transactions?sortBy=stellar_timestamp&sortOrder=desc"

# Sort by amount ascending
curl -H "x-user-id: $USER_ID" \
  "/api/transactions?sortBy=amount&sortOrder=asc"
```

### Filtering with Multiple Criteria

```bash
# Filter by type and vault
curl -H "x-user-id: $USER_ID" \
  "/api/transactions?type=creation&vault_id=$VAULT_ID"

# Date range filter
curl -H "x-user-id: $USER_ID" \
  "/api/transactions?date_from=2025-01-01T00:00:00.000Z&date_to=2025-01-31T23:59:59.999Z"
```

### Cursor-Based Pagination

```bash
# Initial request
curl -H "x-user-id: $USER_ID" \
  "/api/transactions?limit=5"

# Follow-up using cursor from response
curl -H "x-user-id: $USER_ID" \
  "/api/transactions?limit=5&cursor=$NEXT_CURSOR"
```

### Analytics Date Range

```bash
# Weekly trends for a month
curl -H "x-api-key: $API_KEY" \
  "/api/analytics/milestones/trends?from=2025-01-01T00:00:00.000Z&to=2025-01-31T23:59:59.999Z&groupBy=week"

# Daily behavior score
curl -H "x-api-key: $API_KEY" \
  "/api/analytics/behavior?userId=user-123&from=2025-01-01T00:00:00.000Z&to=2025-01-07T23:59:59.999Z"
```

## Implementation Details

### Query Parser Middleware

The `queryParser` middleware in `src/middleware/queryParser.ts` handles validation:

```typescript
queryParser({
  allowedSortFields: ['created_at', 'stellar_timestamp', 'amount', 'type'],
  allowedFilterFields: ['type', 'vault_id', 'date_from', 'date_to']
})
```

### Pagination Utilities

Pagination is handled by utilities in `src/utils/pagination.ts`:

- `parsePaginationParams()` - Offset pagination
- `parseCursorPaginationParams()` - Cursor pagination
- `parseSortParams()` - Sort validation
- `parseFilterParams()` - Filter extraction

### Contract Testing

All list endpoints have contract tests in their respective test files:

- `src/routes/vaults.test.ts` - Vault list contract tests
- `src/routes/transactions.test.ts` - Transaction list contract tests
- `src/routes/analytics.milestones.test.ts` - Analytics contract tests

The reusable contract test helper is at `src/tests/helpers/listContract.ts`.
