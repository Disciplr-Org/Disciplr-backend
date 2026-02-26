# disciplr-backend

API and milestone engine for Disciplr: programmable time-locked capital vaults on Stellar.

## What it does

- **Health:** `GET /api/health` — service status and timestamp.
- **Vaults:**  
  - `GET /api/vaults` — list all vaults with pagination, sorting, and filtering.  
  - `POST /api/vaults` — create a vault (body: `creator`, `amount`, `endTimestamp`, `successDestination`, `failureDestination`).  
  - `GET /api/vaults/:id` — get a vault by id.
- **Transactions:**
  - `GET /api/transactions` — list all transactions with pagination, sorting, and filtering.
  - `GET /api/transactions/:id` — get a transaction by id.
- **Analytics:**
  - `GET /api/analytics` — list analytics views with pagination, sorting, and filtering.

All list endpoints support consistent query parameters for pagination (`page`, `pageSize`), sorting (`sortBy`, `sortOrder`), and filtering (endpoint-specific fields). See [API Patterns Documentation](docs/API_PATTERNS.md) for details.

Data is stored in memory for now. Production would use PostgreSQL, a Horizon listener for on-chain events, and a proper milestone/verification engine.
- `GET /api/health`: service status and timestamp
- `GET /api/vaults`: list all vaults (currently in-memory placeholder)
- `POST /api/vaults`: create a vault
- `GET /api/vaults/:id`: get a vault by id

## Tech stack

- Node.js + TypeScript
- Express
- Helmet + CORS
- PostgreSQL migrations via Knex

## Local setup

Prerequisites:

- Node.js 18+
- npm

Install and run:

```bash
npm install
npm run dev
```

API runs at `http://localhost:3000`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with tsx watch |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run compiled `dist/index.js` |
| `npm run lint` | Run ESLint on `src` |
| `npm run migrate:make <name>` | Create migration file in `db/migrations` |
| `npm run migrate:latest` | Apply all pending migrations |
| `npm run migrate:rollback` | Roll back the latest migration batch |
| `npm run migrate:status` | Show migration status |
| `npm run seed` | Show seed script usage |
| `npm run seed:users` | Seed users table with sample data |
| `npm run seed:vaults` | Seed vaults table with sample data |
| `npm run seed:milestones` | Seed milestones table with sample data |
| `npm run seed:transactions` | Seed transactions table with sample data |
| `npm run seed:all` | Run all seed scripts sequentially |

## Database migrations

Migration tooling is standardized with Knex and PostgreSQL.

- Config: `knexfile.cjs`
- Baseline migration: `db/migrations/20260225190000_initial_baseline.cjs`
- Full process (authoring, rollout, rollback, CI/CD): `docs/database-migrations.md`

```bash
npm run migrate:latest
npm run migrate:status
```

## Seed Data

The project includes comprehensive seed scripts to populate your local development environment with realistic example data. These scripts are **production-safe** and will only run in non-production environments.

### Environment Safety

Seed scripts automatically check for `NODE_ENV !== 'production'` and will refuse to run in production environments.

### Available Seed Scripts

| Script | Description | Sample Data |
|---|---|---|
| `npm run seed:users` | Creates users with different statuses | 7 users (active, inactive, admin) |
| `npm run seed:vaults` | Creates vaults with different statuses | 8 vaults (active, completed, failed, cancelled) |
| `npm run seed:milestones` | Creates milestones with different statuses | 10 milestones (pending, completed, overdue) |
| `npm run seed:transactions` | Creates transactions with different statuses | 15 transactions (success, pending, failed) |
| `npm run seed:all` | Runs all seed scripts in sequence | All above data |

### Quick Start

1. **Set up your database:**
   ```bash
   npm run migrate:latest
   ```

2. **Seed all data:**
   ```bash
   npm run seed:all
   ```

3. **Or seed individual entities:**
   ```bash
   npm run seed:users
   npm run seed:vaults
   npm run seed:milestones
   npm run seed:transactions
   ```

### Data Relationships

- **Users** are the foundation - other entities reference user emails
- **Vaults** belong to users (creator field)
- **Milestones** are linked to vaults via foreign keys
- **Transactions** reference both vaults and users

### Safe Re-running

All seed scripts use **upsert logic**:
- Existing records are updated with new data
- New records are inserted if they don't exist
- No duplicate data is created
- Scripts can be run multiple times safely

### Sample Data Summary

**Users:**
- John Doe (active)
- Jane Smith (active) 
- Admin User (admin)
- Inactive User (inactive)
- Alice Johnson (active)
- Bob Wilson (inactive)
- Super Admin (admin)

**Vaults:**
- Various amounts ($500 - $10,000)
- Different time periods (1-12 months)
- All statuses represented
- Realistic blockchain addresses

**Milestones:**
- Goal-based targets (25%, 50%, etc.)
- Different due dates
- Progress tracking
- Status-based filtering

**Transactions:**
- Deposits, withdrawals, refunds
- Different statuses and amounts
- Transaction hashes for successful operations
- Descriptive purposes

### Troubleshooting

**"Seed scripts cannot be run in production"**
- Ensure `NODE_ENV` is not set to `production`
- For local development, unset NODE_ENV or set to `development`

**"No vaults found" when seeding milestones/transactions**
- Run `npm run seed:vaults` first
- Vault data is required for dependent entities

**Database connection errors**
- Verify `DATABASE_URL` is correctly set
- Ensure PostgreSQL is running
- Run migrations first: `npm run migrate:latest`
disciplr-backend/
├── src/
│   ├── routes/
│   │   ├── health.ts
│   │   ├── vaults.ts
│   │   ├── transactions.ts
│   │   └── analytics.ts
│   ├── middleware/
│   │   └── queryParser.ts
│   ├── utils/
│   │   └── pagination.ts
│   ├── types/
│   │   └── pagination.ts
│   └── index.ts
├── docs/
│   └── API_PATTERNS.md
├── examples/
│   └── api-usage.md
├── package.json
├── tsconfig.json
└── README.md
```
Required env var:

- `DATABASE_URL` (PostgreSQL connection string)

Quick start:

```bash
npm run migrate:latest
npm run migrate:status
```
