# Disciplr Backend

[![CI](https://github.com/Disciplr-Org/Disciplr-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Disciplr-Org/Disciplr-backend/actions/workflows/ci.yml)
[![Live API](https://img.shields.io/badge/live-API-3ddc97)](https://disciplr-api.vercel.app)

API and milestone engine for **Disciplr**: programmable, time-locked commitment vaults on Stellar. A creator locks funds against milestones, a verifier validates progress, and funds release to a success destination or redirect to a failure destination.

- **Live API and docs:** https://disciplr-api.vercel.app
- **OpenAPI spec:** https://disciplr-api.vercel.app/api/openapi.json
- **Live demo (frontend):** https://disciplr-frontend.vercel.app
- **Frontend repo:** [Disciplr-Frontend](https://github.com/Disciplr-Org/Disciplr-Frontend) (consumes this API), live at https://disciplr-frontend.vercel.app

## Quick try

```bash
curl https://disciplr-api.vercel.app/api/health
curl https://disciplr-api.vercel.app/api/vaults
curl https://disciplr-api.vercel.app/api/stats
```

## Endpoints (deployed serverless API)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Process liveness, independent of database availability |
| GET | `/api/ready` | Database readiness, active store and latest applied migration; 503 during outages |
| GET | `/api/vaults?creator=&status=` | List vaults with milestones |
| POST | `/api/vaults` | Create a vault (`creator`, `verifier`, `amount`, `endDate`, `milestones[]`) |
| GET | `/api/vaults/:id` | Vault detail with activity |
| POST | `/api/vaults/:id/milestones/:mid/validate` | Verifier validates a milestone (body `{verifier}`); the vault completes and releases funds when all milestones pass |
| POST | `/api/vaults/:id/fail` | Verifier fails the vault; funds redirect to the failure destination |
| GET | `/api/transactions` | Activity feed (create, validate, release, redirect) |
| GET | `/api/stats` | Aggregate statistics |

The serverless entry point is `api/index.mjs`; the data layer is `apilib/store.mjs`.

## Architecture

```
Frontend (Vite + React, Vercel) --HTTPS--> api/index.mjs (Express on Vercel Functions)
                                                 |
                                                 +--> Neon Postgres (vaults, milestones, activity_log)   [DATABASE_URL set]
                                                 +--> in-memory demo store                              [DATABASE_URL unset]
```

The repository also contains the larger TypeScript service under `src/` (auth, organisations, webhooks, exports, Horizon listener, jobs; see `docs/`) and the Soroban contract workspace in `contracts/`. The deployed API is the lean subset above that runs on serverless.

## Setup

```bash
npm install
cp .env.example .env            # if present; set DATABASE_URL=postgres://...
npm run migrate:latest          # applies the Knex migrations in db/migrations
node api/index.mjs              # serves http://localhost:3001 (PORT to override)
npm run seed:demo               # optional: explicitly insert demo fixtures
```

Without `DATABASE_URL`, non-production uses an in-memory demo store (data resets on restart or cold start); production fails closed. `STORE_MODE=memory` explicitly opts into demo mode. With a database URL, connection failures return 503 with `Retry-After` and later requests retry; they never switch to demo memory. The real `vaults`, `milestones` and `activity_log` tables are owned by migrations. Store initialization only checks connectivity and never seeds or rewrites rows. Run `npm run seed:demo` explicitly to insert demo fixtures; repeated runs preserve existing vaults and their children. Production seeding refuses to run unless `--force` is passed (`npm run seed:demo -- --force`).

### Running API Integration Tests Locally

The integration tests under `api/__tests__/` test the deployed serverless API routes against either a real Postgres database or the fallback in-memory store.

1. **Against local Postgres (via Docker):**
   ```bash
   docker run -d --name disciplr-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=disciplr_test -p 5432:5432 postgres:16
   DATABASE_URL=postgres://postgres:password@localhost:5432/disciplr_test npm run migrate:latest
   DATABASE_URL=postgres://postgres:password@localhost:5432/disciplr_test npm run test:api
   ```

2. **Against the in-memory store:**
   ```bash
   npm run test:api
   ```

Full service (optional): `npm run dev` (needs the variables documented in `docs/configuration.md`). Tests: `npm test`. OpenAPI for the full service: `npm run openapi:generate`.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | for Postgres | PostgreSQL connection URL (Neon pooled URL in production) |
| `STORE_MODE` | no | `postgres` or explicit `memory`; defaults to Postgres when a URL is set or in production |
| `DATABASE_CA_CERT` | no | PEM CA certificate for remote Postgres; remote TLS verifies certificates by default |
| `DATABASE_SSL_INSECURE` | no | Only `1` disables certificate verification and logs a warning; loopback hosts use no TLS |
| `CORS_ORIGINS` | no | Comma-separated allowed origins for cross-origin writes (defaults to `https://disciplr-frontend.vercel.app` in non-production; fails closed when unset in production) |
| `PORT` | no | Local port for `node api/index.mjs` (default 3001) |

## Deployment

Deployed on Vercel (project `disciplr-api`, database: Neon via the Vercel integration). `vercel.json` rewrites `/api/*` to the serverless function and serves `public/index.html` as the docs landing page.

Configure `CORS_ORIGINS` in the Vercel project settings to specify permitted frontend origins (e.g. `https://disciplr-frontend.vercel.app` and any active Vercel preview URLs). When unset in production, the API fails closed and rejects cross-origin state-changing requests (`POST /api/vaults`, `/validate`, `/fail`) with 403 Forbidden. Public read endpoints (`GET /api/health`, `/api/vaults`, `/api/stats`, `/api/transactions`, `/api/openapi.json`) permit cross-origin access.

```bash
vercel --prod --yes
```

Migrations are run against the database with `DATABASE_URL=<unpooled url> npm run migrate:latest`. A previous migration indexed `vaults.org_id`, a column that does not exist; that index now lives in `20260425140000_add_organization_id_to_vaults.cjs` on `organization_id`, and all 75 migrations apply cleanly on a fresh Postgres.

Run migrations before deploying this API version. The activity-log migration upgrades the old runtime-created table, checks legacy rows before adding constraints, and reports violation counts without changing those rows. Remediate reported rows before retrying. Demo seeding is optional and never part of startup or deployment.

## Limitations

- The public demo API has no authentication; the `verifier` address in the request body authorises validation. Do not use it for real funds.
- With `SOROBAN_ENABLED=1` (plus `SOROBAN_RPC_URL`, `SOROBAN_NETWORK_PASSPHRASE`, `VAULT_CONTRACT_ID`, `VAULT_TOKEN_ID`), `POST /vaults` returns unsigned `create_vault` XDR for the creator's wallet; the signed XDR goes to `POST /vaults/:id/onchain/submit`, then `POST /vaults/:id/onchain/stake` + submit funds the vault. Activity rows carry the real tx hash and ledger. The server never holds user keys. Verifier/claim/slash settlement remains simulated.
- Without it, settlement in the deployed API is simulated (activity rows with random hashes, status `simulated`). On-chain settlement is part of the Soroban contracts in `contracts/`, which are not wired to the serverless API.
- The pgvector-dependent `milestone_embeddings` migration is skipped when the extension is unavailable.

## Further documentation

See `docs/` (vault API, state machine, auth, webhooks, migrations, runbooks). The pre-existing detailed README is preserved in git history.
