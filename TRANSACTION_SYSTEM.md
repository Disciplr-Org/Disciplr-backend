# Transaction History System

This document describes the transaction history aggregation and API system implemented for Disciplr.

## Overview

The transaction history system captures all vault-related operations from the Stellar network and provides a comprehensive API for querying transaction history with filters and pagination.

## Architecture

### Database Layer
- **PostgreSQL** database with optimized `transactions` table
- Proper indexing for efficient querying by user, vault, and timestamp
- Support for JSON metadata storage

### ETL Service
- **Stellar Horizon** integration for real-time transaction monitoring
- Automatic extraction of vault-related operations
- Bulk insert operations for high-volume scenarios
- Graceful error handling and retry logic

### API Layer
- RESTful endpoints for transaction queries
- Advanced filtering capabilities
- Pagination support
- Input validation and error handling

## Database Schema

### Transactions Table

```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userId VARCHAR(56) NOT NULL,
  vaultId VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL CHECK (type IN ('creation', 'validation', 'release', 'redirect', 'cancel')),
  amount DECIMAL(20, 7) NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  stellarHash VARCHAR(64) UNIQUE,
  link TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Indexes

- `idx_transactions_user_id` - User-based queries
- `idx_transactions_vault_id` - Vault-based queries  
- `idx_transactions_timestamp` - Time-based sorting
- `idx_transactions_type` - Type filtering
- `idx_transactions_stellar_hash` - Stellar hash lookups
- `idx_transactions_user_timestamp` - User history queries
- `idx_transactions_vault_timestamp` - Vault history queries

## API Endpoints

### GET /api/transactions
List transactions with filters and pagination.

**Query Parameters:**
- `type` - Transaction type filter (creation, validation, release, redirect, cancel)
- `vault` - Vault ID filter
- `userId` - User ID filter
- `startDate` - Start date filter (ISO 8601)
- `endDate` - End date filter (ISO 8601)
- `minAmount` - Minimum amount filter
- `maxAmount` - Maximum amount filter
- `page` - Page number (default: 1)
- `limit` - Results per page (1-100, default: 50)

**Response:**
```json
{
  "transactions": [...],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 100,
    "totalPages": 2
  }
}
```

### GET /api/transactions/:id
Get a specific transaction by ID.

### GET /api/transactions/vault/:vaultId
Get all transactions for a specific vault.

### GET /api/transactions/user/:userId
Get all transactions for a specific user.

### POST /api/transactions
Create a new transaction (for testing/manual entry).

**Request Body:**
```json
{
  "userId": "G...",
  "vaultId": "vault-123",
  "type": "creation",
  "amount": "1000.0000000",
  "timestamp": "2024-01-01T00:00:00Z",
  "stellarHash": "abc123...",
  "link": "https://stellar.expert/explorer/testnet/tx/abc123...",
  "metadata": {...}
}
```

### PUT /api/transactions/:id/link
Update transaction link.

## Transaction Types

- **creation** - Vault creation
- **validation** - Vault validation/verification
- **release** - Fund release from vault
- **redirect** - Fund redirection
- **cancel** - Vault cancellation

## ETL Process

### Initial Sync
- Fetches last 24 hours of transactions from Stellar Horizon
- Processes vault-related operations
- Bulk inserts into database

### Real-time Streaming
- Subscribes to Stellar Horizon transaction stream
- Processes new transactions as they occur
- Updates database in real-time

### Operation Detection
The ETL service identifies vault-related operations through:
- Memo patterns (vault-*, disciplr, time-lock)
- Specific operation types (payment, create_account, set_options)
- Destination account patterns
- Custom operation metadata

## Environment Configuration

Create a `.env` file based on `env.example`:

```env
# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/disciplr

# Stellar Horizon Configuration
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK=TESTNET
STELLAR_DISCIPLR_ACCOUNT=G...

# Server Configuration
PORT=3000
```

## Setup Instructions

### 1. Database Setup
```bash
# Create PostgreSQL database
createdb disciplr

# Run migration
psql disciplr < migrations/001_create_transactions_table.sql
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
```bash
cp env.example .env
# Edit .env with your configuration
```

### 4. Start Service
```bash
npm run dev
```

## Usage Examples

### Query User Transaction History
```bash
curl "http://localhost:3000/api/transactions?userId=GABC...&page=1&limit=20"
```

### Query Vault Transactions by Type
```bash
curl "http://localhost:3000/api/transactions?vault=vault-123&type=release"
```

### Query Transactions by Date Range
```bash
curl "http://localhost:3000/api/transactions?startDate=2024-01-01T00:00:00Z&endDate=2024-01-31T23:59:59Z"
```

### Query by Amount Range
```bash
curl "http://localhost:3000/api/transactions?minAmount=100&maxAmount=10000"
```

## Performance Considerations

### Database Optimization
- Composite indexes for common query patterns
- Proper indexing for pagination
- Connection pooling configured

### ETL Performance
- Bulk insert operations (up to 200 transactions per batch)
- Streaming API for real-time updates
- Error handling with retry logic

### API Performance
- Pagination limits (max 100 per page)
- Efficient query patterns
- Response size optimization

## Error Handling

### Validation Errors
- Input validation for all API endpoints
- Proper error messages with field information
- HTTP status codes (400 for validation errors)

### Database Errors
- Connection error handling
- Transaction rollback on failures
- Graceful degradation

### ETL Errors
- Retry logic for failed transactions
- Logging for debugging
- Continuation of service on individual failures

## Monitoring

### Health Check
```bash
curl http://localhost:3000/api/health
```

### ETL Status
The ETL service logs its status and any errors to the console.

## Security

### Input Validation
- All inputs validated before processing
- SQL injection prevention through parameterized queries
- Amount precision validation

### Data Protection
- No sensitive data logged
- Secure database connections
- Environment variable configuration

## Future Enhancements

### Additional Features
- Transaction statistics and analytics
- Real-time WebSocket updates
- Advanced filtering options
- Export functionality

### Performance Improvements
- Database partitioning for large datasets
- Caching layer for frequently accessed data
- Optimized ETL processing

### Monitoring & Observability
- Metrics collection
- Distributed tracing
- Alerting system
