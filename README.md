# disciplr-backend

API and milestone engine for Disciplr: programmable time-locked capital vaults on Stellar.

## What it does

- **Health:** `GET /api/health` - service status and timestamp.
- **Auth:**
  - `POST /api/auth/login` - mock login and audit logging.
  - `POST /api/auth/users/:id/role` - role changes (admin only) with audit logging.
- **Vaults:**
  - `GET /api/vaults` - list all vaults with pagination, sorting, and filtering.
  - `POST /api/vaults` - create a vault (body: `creator`, `amount`, `endTimestamp`, `successDestination`, `failureDestination`, optional `milestones`).
  - `GET /api/vaults/:id` - get a vault by id.
  - `POST /api/vaults/:id/milestones/:mid/validate` - validate an assigned milestone as verifier.
  - `POST /api/vaults/:id/cancel` - cancel a vault (creator/admin) with audit logging.
  - `GET /api/health/security` - abuse monitoring metrics snapshot.
- **Transactions:**
  - `GET /api/transactions` - list all transactions with pagination, sorting, and filtering.
  - `GET /api/transactions/:id` - get a transaction by id.
- **Analytics:**
  - `GET /api/analytics` - list analytics views with pagination, sorting, and filtering.
- **Admin:**
  - `POST /api/admin/overrides/vaults/:id/cancel` - admin override to cancel vault with audit logging.
  - `GET /api/admin/audit-logs` - admin-only audit log query endpoint.
  - `GET /api/admin/audit-logs/:id` - admin-only single audit log lookup.

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

## User Audit Logging (Issue #45)

This project tracks sensitive actions in an in-memory `audit_logs` table shape:

- `id`
- `actor_user_id`
- `action`
- `target_type`
- `target_id`
- `metadata`
- `created_at`

Current audited actions:

- `auth.login`
- `auth.role_changed`
- `vault.created`
- `vault.cancelled`
- `admin.override`

Admin-only access requirements for audit query endpoints:

- `x-user-role: admin`
- `x-user-id: <admin-user-id>`

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

## Abuse detection instrumentation

The backend includes abuse-oriented security instrumentation middleware.

- `GET /api/health/security` returns:
  - failed login attempts seen by auth/login paths (`401` or `403`)
  - rate limit triggers (`429`)
  - suspicious pattern alerts by category
  - top active source IPs in current windows
- Structured JSON logs are emitted for:
  - `security.failed_login_attempt`
  - `security.rate_limit_triggered`
  - `security.suspicious_pattern`

### Thresholds (env-configurable)

| Env var | Default | Meaning |
|---|---|---|
| `SECURITY_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit lookback window |
| `SECURITY_RATE_LIMIT_MAX_REQUESTS` | `120` | Max requests per IP in rate-limit window |
| `SECURITY_SUSPICIOUS_WINDOW_MS` | `300000` | Lookback window for suspicious pattern checks |
| `SECURITY_SUSPICIOUS_404_THRESHOLD` | `20` | 404 count threshold for endpoint scan detection |
| `SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD` | `12` | Distinct 404 path threshold for endpoint scan detection |
| `SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD` | `30` | 400 count threshold for repeated bad request detection |
| `SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD` | `300` | Total request threshold for high-volume bursts |
| `SECURITY_FAILED_LOGIN_WINDOW_MS` | `900000` | Lookback window for failed login burst checks |
| `SECURITY_FAILED_LOGIN_BURST_THRESHOLD` | `5` | Failed login threshold per IP before alert |
| `SECURITY_ALERT_COOLDOWN_MS` | `300000` | Minimum time between repeated alerts per IP/pattern |

### Alert wiring guidance

No dedicated monitoring stack is wired in this repo yet. If your environment has one (Datadog, CloudWatch, Grafana Loki, ELK), create alerts on these log events:

- `security.rate_limit_triggered`: alert on sustained frequency or concentration from a single IP.
- `security.suspicious_pattern` where `pattern` is:
  - `endpoint_scan`
  - `high_volume`
  - `repeated_bad_requests`
  - `failed_login_burst`

Recommended initial alert policy:

- Warning: any `security.suspicious_pattern` event.
- Critical: `security.rate_limit_triggered` over 20 times in 5 minutes from one IP.

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
|  |  |- analytics.ts
|  |  |- auth.ts
|  |  `- admin.ts
|  |  `- privacy.ts
|  |- middleware/
|  |  |- queryParser.ts
|  |  `- privacy-logger.ts
|  |- security/
|  |  `- abuse-monitor.ts
|  |- utils/
|  |  `- pagination.ts
|  |- types/
|  |  `- pagination.ts
|  `- index.ts
|- docs/
|  `- database-migrations.md
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
