# Transactions API Documentation

## Overview

The Transactions API provides comprehensive access to vault-related transaction history aggregated from Stellar Horizon events. It supports filtering, pagination, and real-time synchronization of on-chain transactions.

## Transaction Types

The system tracks the following vault-related transaction types:

- **creation**: Vault creation events
- **validation**: Small validation transactions (typically 0.0000001 XLM)
- **release**: Principal release transactions
- **redirect**: Transaction redirection events
- **cancel**: Vault cancellation events

## Endpoints

### GET /api/transactions

List all vault transactions with filtering and pagination.

#### Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `page` | number | Page number (default: 1) | `1` |
| `pageSize` | number | Items per page (max: 100, default: 20) | `20` |
| `vaultId` | string | Filter by vault ID | `vault-123` |
| `type` | string | Filter by transaction type | `creation` |
| `dateFrom` | string | Filter transactions from this date (ISO 8601) | `2024-01-01T00:00:00Z` |
| `dateTo` | string | Filter transactions until this date (ISO 8601) | `2024-01-31T23:59:59Z` |
| `amount` | string | Filter by exact amount | `100.0000000` |

#### Response Format

```json
{
  "data": [
    {
      "id": "tx-vault-123-1704067200000-abc123",
      "vault_id": "vault-123",
      "type": "creation",
      "amount": "100.0000000",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "stellar_transaction_hash": "abc123...",
      "stellar_explorer_url": "https://steexp.com/tx/abc123...",
      "metadata": {
        "operation_id": "op-456",
        "operation_type": "create_account",
        "source_account": "GABC...",
        "transaction_memo": "vault creation"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 150
  }
}
```

#### Example Requests

```bash
# Get all transactions
GET /api/transactions

# Filter by vault
GET /api/transactions?vaultId=vault-123

# Filter by type and date range
GET /api/transactions?type=creation&dateFrom=2024-01-01T00:00:00Z&dateTo=2024-01-31T23:59:59Z

# Paginated results
GET /api/transactions?page=2&pageSize=10
```

### GET /api/transactions/:id

Get a single transaction by its unique ID.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Transaction ID |

#### Response Format

```json
{
  "id": "tx-vault-123-1704067200000-abc123",
  "vault_id": "vault-123",
  "type": "creation",
  "amount": "100.0000000",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "stellar_transaction_hash": "abc123...",
  "stellar_explorer_url": "https://steexp.com/tx/abc123...",
  "metadata": {
    "operation_id": "op-456",
    "operation_type": "create_account",
    "source_account": "GABC...",
    "transaction_memo": "vault creation"
  }
}
```

#### Example Request

```bash
GET /api/transactions/tx-vault-123-1704067200000-abc123
```

### POST /api/transactions/sync/:vaultId

Synchronize transactions for a specific vault from Stellar Horizon. This endpoint triggers the ETL process to fetch and process on-chain transactions.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `vaultId` | string | Vault account ID to sync |

#### Response Format

```json
{
  "message": "Synced 3 transactions for vault vault-123",
  "data": [
    {
      "id": "tx-vault-123-1704067200000-abc123",
      "vault_id": "vault-123",
      "type": "creation",
      "amount": "100.0000000",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "stellar_transaction_hash": "abc123...",
      "stellar_explorer_url": "https://steexp.com/tx/abc123..."
    }
  ]
}
```

#### Example Request

```bash
POST /api/transactions/sync/vault-123
```

## Data Model

### Transaction Record

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique transaction identifier |
| `vault_id` | string | Associated vault ID |
| `type` | enum | Transaction type (creation, validation, release, redirect, cancel) |
| `amount` | string | Transaction amount in XLM (optional) |
| `timestamp` | datetime | When the transaction occurred |
| `stellar_transaction_hash` | string | Stellar transaction hash (optional) |
| `stellar_explorer_url` | string | Link to Stellar Explorer (optional) |
| `metadata` | object | Additional transaction metadata |

## Error Handling

The API returns standard HTTP status codes:

- `200` - Success
- `400` - Bad request (invalid parameters)
- `404` - Transaction not found
- `500` - Internal server error

Error response format:

```json
{
  "error": "Transaction not found"
}
```

## Rate Limiting

The ETL service respects Stellar Horizon rate limits. When syncing large vaults, consider implementing:

- Exponential backoff for failed requests
- Request queuing for high-volume operations
- Caching to avoid duplicate sync operations

## Integration Examples

### JavaScript/TypeScript

```typescript
// Fetch transactions for a vault
const response = await fetch('/api/transactions?vaultId=vault-123&type=creation')
const data = await response.json()

// Sync vault transactions
const syncResponse = await fetch('/api/transactions/sync/vault-123', {
  method: 'POST'
})
const syncData = await syncResponse.json()
```

### cURL

```bash
# List transactions with filters
curl -X GET "http://localhost:3000/api/transactions?vaultId=vault-123&type=creation&page=1&pageSize=10"

# Get single transaction
curl -X GET "http://localhost:3000/api/transactions/tx-vault-123-1704067200000-abc123"

# Sync vault transactions
curl -X POST "http://localhost:3000/api/transactions/sync/vault-123"
```

## Testing

The API includes comprehensive test coverage:

- Unit tests for ETL service logic
- Integration tests for API endpoints
- Mocked Stellar Horizon responses for reliable testing

Run tests:

```bash
npm test
npm test -- --testPathPattern=transactions
```

## Database Schema

The transactions table stores:

```sql
CREATE TABLE transactions (
  id VARCHAR(64) PRIMARY KEY,
  vault_id VARCHAR(64) NOT NULL,
  type transaction_type NOT NULL,
  amount DECIMAL(36, 7),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  stellar_transaction_hash VARCHAR(64) UNIQUE,
  stellar_explorer_url TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_transactions_vault_id ON transactions(vault_id);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_timestamp ON transactions(timestamp);
CREATE INDEX idx_transactions_stellar_hash ON transactions(stellar_transaction_hash);
```

## Performance Considerations

- Database indexes on frequently queried fields (vault_id, type, timestamp)
- Pagination to limit result sets
- Efficient ETL processing with batch operations
- Connection pooling for database operations
- Horizon API rate limit handling
