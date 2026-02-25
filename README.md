# disciplr-backend

API and milestone engine for Disciplr: programmable time-locked capital vaults on Stellar.

## What it does

- **Health:** `GET /api/health` - service status and timestamp.
- **Vaults:**
  - `GET /api/vaults` - list all vaults with pagination, sorting, and filtering.
  - `POST /api/vaults` - create a vault (body: `creator`, `amount`, `endTimestamp`, `successDestination`, `failureDestination`, optional `milestones`).
  - `GET /api/vaults/:id` - get a vault by id.
  - `POST /api/vaults/:id/milestones/:mid/validate` - validate an assigned milestone as verifier.
- **Transactions:**
  - `GET /api/transactions` - list all transactions with pagination, sorting, and filtering.
  - `GET /api/transactions/:id` - get a transaction by id.
- **Analytics:**
  - `GET /api/analytics` - list analytics views with pagination, sorting, and filtering.

All list endpoints support consistent query parameters for pagination (`page`, `pageSize`), sorting (`sortBy`, `sortOrder`), and filtering (endpoint-specific fields). See [API Patterns Documentation](docs/API_PATTERNS.md) for details.

Data is stored in memory for now. Production would use PostgreSQL, a Horizon listener for on-chain events, and a proper milestone/verification engine.

## Milestone validation behavior

- Enforces verifier role via `x-user-role: verifier` header.
- Enforces assigned verifier via `x-user-id` matching milestone `verifierId`.
- Persists validation event in `vault.validationEvents`.
- Updates milestone state (`pending` -> `validated`) and `validatedAt`/`validatedBy`.
- Emits domain events in `vault.domainEvents`:
  - `milestone.validated` for every successful validation.
  - `vault.state_changed` when all milestones are validated and vault transitions to `completed`.

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
| `npm run test` | Run Jest test suite |
| `npm run test:watch` | Run Jest in watch mode |
| `npm run test:api-keys` | Run API key route tests |
| `npm run migrate:make <name>` | Create migration file in `db/migrations` |
| `npm run migrate:latest` | Apply all pending migrations |
| `npm run migrate:rollback` | Roll back the latest migration batch |
| `npm run migrate:status` | Show migration status |

## Database migrations

Migration tooling is standardized with Knex and PostgreSQL.

- Config: `knexfile.cjs`
- Baseline migration: `db/migrations/20260225190000_initial_baseline.cjs`
- Full process (authoring, rollout, rollback, CI/CD): `docs/database-migrations.md`

```text
disciplr-backend/
|- src/
|  |- routes/
|  |  |- health.ts
|  |  |- vaults.ts
|  |  |- transactions.ts
|  |  `- analytics.ts
|  |- middleware/
|  |  `- queryParser.ts
|  |- utils/
|  |  `- pagination.ts
|  |- types/
|  |  `- pagination.ts
|  `- index.ts
|- docs/
|  `- API_PATTERNS.md
|- package.json
|- tsconfig.json
`- README.md
```

Required env var:

- `DATABASE_URL` (PostgreSQL connection string)

Quick start:

```bash
npm run migrate:latest
npm run migrate:status
```
