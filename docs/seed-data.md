# Database Seed Data Documentation

This document provides comprehensive information about the seed data system used to populate the Disciplr backend development environment with realistic example data.

## Overview

The seed system is designed to:
- Provide realistic test data for development and testing
- Support safe, repeatable execution
- Prevent accidental execution in production
- Maintain data relationships and consistency
- Support individual entity seeding or complete database population

## Environment Safety

All seed scripts include production safety checks:

```typescript
if (process.env.NODE_ENV === 'production') {
  console.error('❌ Seed scripts cannot be run in production environment')
  process.exit(1)
}
```

## Available Scripts

### Individual Entity Scripts

| Command | Purpose | Records Created |
|---|---|---|
| `npm run seed:users` | Seed users table | 7 users |
| `npm run seed:vaults` | Seed vaults table | 8 vaults |
| `npm run seed:milestones` | Seed milestones table | 10 milestones |
| `npm run seed:transactions` | Seed transactions table | 15 transactions |

### Combined Scripts

| Command | Purpose |
|---|---|
| `npm run seed:all` | Run all seed scripts in proper order |
| `npm run seed` | Show usage information |

## Data Models

### Users

```typescript
interface User {
  id: string
  email: string
  name: string
  status: 'active' | 'inactive' | 'admin'
  created_at: Date
  updated_at: Date
}
```

**Sample Users:**
- **Active Users:** John Doe, Jane Smith, Alice Johnson
- **Inactive Users:** Inactive User, Bob Wilson
- **Admin Users:** Admin User, Super Admin

### Vaults

```typescript
interface Vault {
  id: string
  creator: string
  amount: number
  start_timestamp: Date
  end_timestamp: Date
  success_destination: string
  failure_destination: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  created_at: Date
}
```

**Sample Vault Characteristics:**
- **Amounts:** $500 - $10,000
- **Durations:** 1-12 months
- **Statuses:** All four statuses represented
- **Destinations:** Realistic blockchain addresses

### Milestones

```typescript
interface Milestone {
  id: string
  vault_id: string
  title: string
  description: string
  target_amount: number
  current_amount: number
  due_date: Date
  status: 'pending' | 'completed' | 'overdue'
  created_at: Date
  updated_at: Date
}
```

**Sample Milestone Types:**
- **Goal-based:** Quarter targets, halfway points
- **Time-based:** Monthly, quarterly goals
- **Progress tracking:** Various completion percentages

### Transactions

```typescript
interface Transaction {
  id: string
  vault_id: string
  user_id: string
  amount: number
  type: 'deposit' | 'withdrawal' | 'refund'
  status: 'success' | 'pending' | 'failed'
  transaction_hash?: string
  description: string
  created_at: Date
  updated_at: Date
}
```

**Sample Transaction Characteristics:**
- **Types:** Deposits (primary), withdrawals, refunds
- **Statuses:** Success, pending, failed scenarios
- **Amounts:** Various sizes from $25 to $2,150
- **Hashes:** Realistic transaction hashes for successful operations

## Execution Order

Dependencies require specific execution order:

1. **Users** - Foundation entity
2. **Vaults** - Depends on users
3. **Milestones** - Depends on vaults
4. **Transactions** - Depends on vaults and users

The `seed:all` command automatically respects this order.

## Upsert Logic

All seed scripts implement safe upsert behavior:

```typescript
// Check for existing record
const existing = await db('table').where('unique_field', value).first()

if (existing) {
  // Update existing record
  await db('table').where('id', existing.id).update(data)
} else {
  // Insert new record
  await db('table').insert({ id: generateId(), ...data })
}
```

**Benefits:**
- No duplicate data creation
- Safe to run multiple times
- Updates existing data with latest sample values
- Maintains referential integrity

## Database Schema Creation

Seed scripts automatically create required tables if they don't exist:

```typescript
const tableExists = await db.schema.hasTable('table_name')
if (!tableExists) {
  await db.schema.createTable('table_name', (table) => {
    // Schema definition
  })
}
```

## Logging and Monitoring

Each script provides comprehensive logging:

```
🌱 Seeding users...
📋 Creating users table...
✅ Users table created
➕ Inserted user: john.doe@example.com
🔄 Updated user: jane.smith@example.com
✅ Users seeding completed: 5 inserted, 2 updated
📊 Users Summary:
   Total: 7
   Active: 4
   Inactive: 2
   Admin: 2
```

## Error Handling

Scripts include comprehensive error handling:

```typescript
try {
  // Seeding logic
} catch (error) {
  console.error('❌ Error seeding users:', error)
  throw error
} finally {
  await db.destroy()
}
```

## Troubleshooting

### Common Issues

**Production Environment Error**
```
❌ Seed scripts cannot be run in production environment
```
**Solution:** Ensure `NODE_ENV` is not set to `production`

**Missing Dependencies**
```
⚠️ No vaults found. Please run vault seeding first.
```
**Solution:** Run seed scripts in dependency order or use `seed:all`

**Database Connection**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```
**Solution:** Verify PostgreSQL is running and `DATABASE_URL` is correct

### Debug Mode

For detailed debugging, set environment variable:
```bash
DEBUG=seed:* npm run seed:all
```

## Rollback Instructions

While seed scripts are designed to be safe, you can clean seeded data:

```sql
-- Clean all seeded data (order matters due to foreign keys)
DELETE FROM transactions;
DELETE FROM milestones;
DELETE FROM vaults;
DELETE FROM users;
```

Or use individual table truncation:
```bash
# Using psql
psql $DATABASE_URL -c "TRUNCATE TABLE transactions, milestones, vaults, users RESTART IDENTITY CASCADE;"
```

## Customization

### Adding New Sample Data

1. Edit the relevant seed file in `seed/` directory
2. Add new objects to the sample data arrays
3. Run the specific seed script

### Modifying Existing Data

1. Update sample data objects in seed files
2. Run seed scripts - they will update existing records
3. Changes are applied safely without creating duplicates

## Best Practices

1. **Always use `seed:all` for complete setup** - ensures proper dependency order
2. **Run migrations first** - ensure database schema is current
3. **Check environment** - verify you're not in production
4. **Monitor logs** - pay attention to inserted/updated counts
5. **Test locally** - verify data relationships work correctly

## Integration with Development Workflow

### Initial Setup
```bash
# Fresh development environment
npm install
npm run migrate:latest
npm run seed:all
npm run dev
```

### Reset Development Data
```bash
# Clean and reseed
npm run migrate:rollback  # Optional: clean slate
npm run migrate:latest
npm run seed:all
```

### Continuous Integration
Seed scripts are designed to be CI-safe:
- Production checks prevent accidental data seeding
- Deterministic results ensure consistent test environments
- Idempotent operations allow repeated executions

## Performance Considerations

- **Batch Operations:** Records are processed individually for clarity
- **Connection Management:** Database connections are properly closed
- **Memory Usage:** Sample data sets are sized appropriately for development
- **Transaction Safety:** Each script runs in a single database session

For large-scale data seeding needs, consider implementing batch insert operations or using database-specific bulk load utilities.
