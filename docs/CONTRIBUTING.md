# Contributing & Local Development (Disciplr Backend)

This guide gets a fresh clone to a **green local test run** for both:

- the backend test suite (run with **Bun**)
- the Soroban smart contract test suite (run with **Cargo**)

---

## 1) Prerequisite Installations

### Install Bun (JS/TypeScript runtime)

1. Download and install Bun from the official site: https://bun.sh/docs/installation
2. Verify:

> **Command**
> ```bash
> bun --version
> ```

### Install Rust + Cargo toolchain (for Soroban)

Install Rust using the official installer:

> **Command**
> ```bash
> rustup toolchain install stable
> rustup default stable
> ```

Verify:

> **Command**
> ```bash
> cargo --version
> rustc --version
> ```

### Install Soroban (Stellar smart contract) toolchain

This repository’s smart contracts live under `contracts/`.

1. Install `soroban-cli` (recommended: follow the Soroban CLI installation instructions from Stellar):
   - https://soroban.stellar.org/
2. Verify the CLI is available:

> **Command**
> ```bash
> soroban --version
> ```

> **Note**
> If your environment uses a different command name for the CLI after install, update the commands below accordingly.

### Install PostgreSQL

Install PostgreSQL locally.

> Recommended: PostgreSQL 14+.

Start it via your platform’s service manager or via Docker.

#### Option A: Docker (quickest for most contributors)

> **Command**
> ```bash
> docker run --name disciplr-postgres \
>   -e POSTGRES_PASSWORD=postgres \
>   -e POSTGRES_USER=postgres \
>   -e POSTGRES_DB=disciplr_test \
>   -p 5432:5432 \
>   -d postgres:16
> ```

#### Option B: Local installer

- Ensure Postgres is running and listening on **localhost:5432**.
- Ensure you can connect with a user that has rights to create/modify tables in the database you will use for tests/dev.

---

## 2) Database Setup (PostgreSQL + Knex migrations)

This backend uses **Knex + PostgreSQL** for schema migrations.

### Create / select a local database

Use a database name dedicated to local development/testing (example: `disciplr_test`).

#### Example `DATABASE_URL`

> **Command (example)**
> ```bash
> export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/disciplr_test
> ```

On Windows (PowerShell), you can use:

> **Command (PowerShell)**
> ```powershell
> $env:DATABASE_URL="postgresql://postgres:postgres@localhost:5432/disciplr_test"
> ```

### Run migrations

Migrations are tracked in `db/migrations/`.

> **Command**
> ```bash
> bun run migrate:latest
> ```

If you want visibility into what has/hasn’t run:

> **Command**
> ```bash
> bun run migrate:status
> ```

### Run development seeding

Seeding populates reference/minimal data needed for integration-style tests and manual local flows.

> **Command (recommended)**
> ```bash
> bun run db:seed
> ```

If your workspace uses a seed entrypoint script directly, the equivalent is often:

> **Command (fallback pattern)**
> ```bash
> bun run src/db/seed.ts
> ```

> **Important**
> If `bun run db:seed` does not exist in your checkout, check `package.json` scripts and use the actual seeding command name.

---

## 3) Testing Suites (Definition of “Green”)

A local run is considered **green** when BOTH suites pass.

### 3.1 Backend tests (Bun)

Run the complete backend test suite:

> **Command**
> ```bash
> bun test
> ```

> **Alternative (if your workspace uses the Jest runner instead of Bun’s test runner)**
> ```bash
> bun run test
> ```

Expected outcome:

- All test files complete successfully
- Integration tests that require Postgres should find the configured `DATABASE_URL`

> **Edge note**
> This repo includes a database test harness that prefers isolation and may skip integration tests gracefully if a live database isn’t reachable. For a true local green run, configure `DATABASE_URL` correctly and ensure migrations are applied.

### 3.2 Smart contract tests (Cargo)

Smart contract code is under `contracts/`.

Run the contract test suite:

> **Command**
> ```bash
> cd contracts && cargo test
> ```

Expected outcome:

- Contract compilation succeeds
- All Rust contract tests pass

> **Note**
> If you only need the accountability vault tests (common for CI parity), you may run a targeted test file/crate, but the definition of green for local onboarding is to run `cargo test` from `contracts/`.

---

## 4) Common Troubleshooting / Edge Cases

### Missing Postgres environment variables

**Symptom**: tests fail with connection errors (or integration tests are skipped).

> **Check**
> - `DATABASE_URL` is set
> - it points to a running Postgres instance (host/port are correct)
> - the database exists (example: `disciplr_test`)

> **Fix**
> - Set `DATABASE_URL` and re-run migrations:
>   
>   > **Command**
>   > ```bash
>   > bun run migrate:latest
>   > bun test
>   > ```

### Un-applied migrations or conflicting migrations

**Symptom**: SQL errors like missing tables/columns, enum mismatches, or constraint failures.

> **Check**
> - `bun run migrate:status` shows pending migrations
> - migrations in `db/migrations/` match the expectations of your local schema

> **Fix**
> - Apply migrations:
>   
>   > **Command**
>   > ```bash
>   > bun run migrate:latest
>   > ```

If you landed in a broken state during local iteration:

> **Safe rollback approach**
> - Roll back the latest migration batch, then re-apply:
> 
> > **Command**
> > ```bash
> > bun run migrate:rollback
> > bun run migrate:latest
> > ```

> **Important**
> Only do rollback/forward cycles against a local disposable database. Do not run destructive migration operations against shared/dev databases.

### Soroban toolchain not installed / contract toolchain misconfiguration

**Symptom**: `cargo test` fails due to missing Soroban-related tooling, missing target configuration, or build script errors.

> **Check**
> - `cargo` is installed and works (`cargo --version`)
> - `soroban` CLI is installed and available (`soroban --version`)
> - you are running tests from the correct directory (`cd contracts` before `cargo test`)

> **Fix**
> - Ensure Soroban is installed
> - Re-run from `contracts/`:
> 
> > **Command**
> > ```bash
> > cd contracts
> > cargo test
> > ```

If you recently changed contract configuration or tool versions, a clean build helps:

> **Command**
> ```bash
> cd contracts && cargo clean && cargo test
> ```

---

## 5) Update Root Navigation (README.md snippet)

Add the following snippet to the root `README.md` (e.g., in the “Docs” / “Development” section):

```md
## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for a complete local setup guide (Postgres + migrations + backend tests with Bun, and contract tests with Cargo/Soroban).
```

