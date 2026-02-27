# Transaction History API Implementation

## Overview

This implementation adds comprehensive transaction history aggregation and APIs for the Disciplr backend, enabling users to view all vault-related on-chain transactions from Stellar.

## Architecture

### Database Schema

#### Users Table
- `id` (UUID, primary key)
- `email` (string, unique)
- `password_hash` (string)
- `created_at`, `updated_at` (timestamps)

#### Transactions Table
- `id` (UUID, primary key)
- `user_id` (UUID, foreign key to users)
- `vault_id` (string, foreign key to vaults)
- `tx_hash` (string, unique, indexed)
- `type` (enum: creation, validation, release, redirect, cancel)
- `amount` (decimal, 36,7)
- `asset_code` (string, nullable)
- `from_account`, `to_account` (Stellar addresses)
- `memo` (text, nullable)
- `created_at`, `stellar_timestamp` (timestamps)
- `stellar_ledger` (integer)
- `explorer_url` (string)

### ETL Pipeline

The `TransactionETLService` handles:

1. **Horizon Integration**: Fetches operations from Stellar Horizon API
2. **Vault Resolution**: Maps operations to specific vaults using multiple strategies
3. **Transformation**: Converts Horizon operations to transaction records
4. **Deduplication**: Prevents duplicate transactions using tx_hash
5. **Persistence**: Saves to database with proper indexing

### API Endpoints

#### GET /api/transactions
- **Authentication**: Required (x-user-id header or Bearer token)
- **Query Parameters**:
  - `type`: Filter by transaction type
  - `vault_id`: Filter by vault ID
  - `date_from`, `date_to`: Date range filter
  - `amount_min`, `amount_max`: Amount range filter
  - `page`, `pageSize`: Pagination
  - `sortBy`, `sortOrder`: Sorting options

#### GET /api/transactions/:id
- Returns specific transaction details

#### GET /api/transactions/vault/:vaultId
- Returns transactions for a specific vault

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://...

# Stellar Horizon
HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# ETL Configuration
ETL_BACKFILL_FROM=2026-01-01T00:00:00Z
ETL_BACKFILL_TO=2026-12-31T23:59:59Z
```

### ETL Worker

The ETL worker runs automatically with configurable intervals:

```typescript
import { etlWorker } from './services/etlWorker.js'

// Start with 5-minute intervals
etlWorker.start(5)

// Stop the worker
etlWorker.stop()

// Manual run
await etlWorker.runETL()
```

## Security

- **Authentication**: All endpoints require valid user authentication
- **Authorization**: Users can only access their own transactions
- **Input Validation**: All query parameters are validated and sanitized
- **SQL Injection Protection**: Uses parameterized queries via Knex.js

## Performance

### Database Indexes

- Primary indexes on `user_id`, `vault_id`, `type`, `created_at`
- Composite index on `(user_id, vault_id, type, created_at)`
- Unique index on `tx_hash` for deduplication

### Query Optimization

- Index-backed queries only (no full table scans)
- Efficient pagination with cursor/offset support
- Proper sorting with database-level ordering

## Testing

### Unit Tests
- ETL transformation logic
- Transaction type mapping
- Database operations

### Integration Tests
- API endpoint functionality
- Authentication and authorization
- Database interactions

### Test Commands

```bash
# Run all tests
npm test

# Run transaction tests specifically
npm run test:transactions

# Run ETL tests specifically
npm run test:etl
```

## Deployment

### Database Migrations

```bash
# Run migrations
npm run migrate:latest

# Create new migration
npm run migrate:make -- migration_name

# Rollback migration
npm run migrate:rollback
```

### ETL Process

1. **Backfill**: Run once to populate historical data
2. **Incremental Sync**: Runs continuously to catch new transactions
3. **Recovery**: Automatic retry and error handling

## Monitoring

### ETL Metrics
- Operations processed per batch
- Error rates and retry counts
- Database write performance
- Horizon API response times

### API Metrics
- Request latency
- Query performance by filter type
- Authentication success rates

## Troubleshooting

### Common Issues

1. **Missing Transactions**: Check ETL worker status and Horizon connectivity
2. **Slow Queries**: Verify database indexes are properly created
3. **Authentication Errors**: Ensure proper headers are being sent
4. **Duplicated Data**: Check ETL deduplication logic and tx_hash uniqueness

### Debug Mode

Enable debug logging:

```bash
DEBUG=etl:* npm run dev
```

## Future Enhancements

1. **Real-time Updates**: WebSocket integration for live transaction updates
2. **Advanced Analytics**: Transaction volume and pattern analysis
3. **Multi-network Support**: Mainnet and other Stellar networks
4. **Export Features**: CSV/PDF export for transaction history
5. **Webhook Support**: Notify external systems of new transactions

## API Examples

### Get User Transactions

```bash
curl -H "x-user-id: user-123" \
  "http://localhost:3000/api/transactions?page=1&pageSize=20&type=release"
```

### Get Vault Transactions

```bash
curl -H "x-user-id: user-123" \
  "http://localhost:3000/api/transactions/vault/vault-456?date_from=2026-02-01"
```

### Response Format

```json
{
  "data": [
    {
      "id": "uuid",
      "vault_id": "vault-uuid",
      "type": "release",
      "amount": "100.0000000",
      "asset_code": "XLM",
      "tx_hash": "abcdef...",
      "explorer_url": "https://stellar.expert/explorer/public/tx/abcdef",
      "created_at": "2026-02-26T12:00:00Z",
      "stellar_timestamp": "2026-02-26T12:00:00Z",
      "stellar_ledger": 12345
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "has_more": true
  }
}
```
