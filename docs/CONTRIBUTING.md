# Contributing and Local Development

This guide takes a new contributor from a clean checkout to a local backend, database migrations, development seed data, backend tests, and the Soroban contract test suite.

## Prerequisites

- Git
- Bun
- Docker or a local PostgreSQL server
- Rust and Cargo for the contract suite
- Stellar CLI only when building or deploying Soroban contracts

Install Bun from the official installer:

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash
```

```powershell
# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Install Rust with `rustup`, then restart the shell so `cargo` is on `PATH`.

## Clone and Install

```bash
git clone https://github.com/Disciplr-Org/Disciplr-backend.git
cd Disciplr-backend
bun install
```

The repository keeps its dependency lock in `bun.lock`. The backend scripts are defined in `package.json` and can be run with `bun run <script>`.

## Environment

Create a local environment file:

```bash
cp .env.example .env
```

```powershell
Copy-Item .env.example .env
```

For the default Docker database, keep:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/disciplr
```

Do not commit `.env` or any real Soroban secret keys. The optional Soroban submit-mode variables can stay as placeholders unless you are testing on-chain submission.

## PostgreSQL

The quickest local database is the `db` service in `docker-compose.yml`:

```bash
docker compose up -d db
docker compose ps db
```

The service exposes PostgreSQL on `localhost:5432` with:

- user: `postgres`
- password: `postgres`
- database: `disciplr`

If you use a local PostgreSQL install instead of Docker, create a database that matches `DATABASE_URL` and ensure the URL starts with `postgres://` or `postgresql://`.

## Migrations

Migrations are managed by Knex with `knexfile.cjs` and live in `db/migrations`.

```bash
bun run migrate:status
bun run migrate:latest
```

Use rollback only for disposable local databases:

```bash
bun run migrate:rollback
```

Before opening a PR that adds or changes schema, run `bun run migrate:status` again and make sure the expected migration batch is applied locally.

## Development Seed Data

There is currently no committed `db/seeds` directory and no seed script in `package.json`. For now, seed a local development run through the public API after migrations are applied.

Start the backend:

```bash
bun run dev
```

In another shell, create a sample vault on Windows:

```bash
curl.exe -X POST http://localhost:3000/api/vaults -H "Content-Type: application/json" -d "{\"creator\":\"dev-user\",\"amount\":100,\"endTimestamp\":\"2030-01-01T00:00:00Z\",\"successDestination\":\"success-wallet\",\"failureDestination\":\"failure-wallet\"}"
```

On macOS/Linux, the same request can be split with backslash line continuations:

```bash
curl -X POST http://localhost:3000/api/vaults \
  -H "Content-Type: application/json" \
  -d '{"creator":"dev-user","amount":100,"endTimestamp":"2030-01-01T00:00:00Z","successDestination":"success-wallet","failureDestination":"failure-wallet"}'
```

Use this API-created data for manual checks. Tests should continue to use the fixture helpers documented in `docs/testing-db.md`, including `seedMinimalFixtures(harness)` where appropriate.

## Backend Checks

Run the package scripts through Bun:

```bash
bun run build
bun run lint
bun run test
```

Useful targeted checks:

```bash
bun run test:smoke
bun run test:api-keys
bun run test:perf
bun run openapi:generate
bun run openapi:validate
```

The `test` script runs Jest through Node's `--experimental-vm-modules` flag. Use `bun run test` so the repository script is executed; bare `bun test` invokes Bun's own test runner and is not the configured project test command.

Integration tests that need PostgreSQL may skip with a `SKIP: no database available` message when `DATABASE_URL` is missing or unreachable. Start the database and re-run the relevant suite before treating the result as green.

## Soroban Contract Checks

The contract workspace is under `contracts/`, and `contracts/README.md` is the source of truth for contract-specific build details.

```bash
cd contracts
cargo test
```

When the Stellar CLI is installed and you need to verify the compiled Wasm:

```bash
stellar contract build
bash build-size-check.sh
```

Return to the repository root before running backend commands again:

```bash
cd ..
```

## Pull Request Workflow

1. Create a focused branch from current `main`.
2. Keep each PR tied to one issue or one coherent fix.
3. Reference the issue in the PR body with `Fixes #<issue-number>` when the PR fully resolves it.
4. Include the exact commands you ran and any known skips or pre-existing failures.
5. Update docs and `docs/openapi.yaml` when API behavior changes.
6. Do not commit `.env`, local database dumps, `node_modules`, Rust `target` outputs, or generated secrets.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `bun` is not found | Install Bun, restart the shell, and confirm `bun --version` works. |
| `DATABASE_URL is required` | Copy `.env.example` to `.env` or export `DATABASE_URL` in the current shell. |
| PostgreSQL connection refused | Run `docker compose up -d db`, check `docker compose ps db`, and confirm port `5432` is not already owned by another local database. |
| Migrations fail on an existing local schema | Run `bun run migrate:status` to inspect state. For disposable local data, recreate the database or roll back the latest local batch. Never point rollback commands at production. |
| Integration tests skip database coverage | Set `NODE_ENV=test`, point `DATABASE_URL` at a local or test database, and start PostgreSQL before rerunning the suite. |
| `cargo` is not found | Install Rust with `rustup`, restart the shell, and confirm `cargo --version` works. |
| `stellar` is not found | Install the Stellar CLI only if you need `stellar contract build`; `cargo test` does not require it. |
| PowerShell treats `curl` differently | Use `curl.exe` for the examples in this guide. |
