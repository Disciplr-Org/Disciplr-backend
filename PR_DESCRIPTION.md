## Summary

Hardens the vault-creation idempotency and reservation boundary (anchored at `src/routes/vaults.ts`, `src/services`, and the `vault_creation_idempotency` reservation table) so concurrent first writes, retries, and adversarial inputs produce exactly one durable vault with unambiguous ownership.

Refs #1520

## Problem

The existing durable idempotency coordinator (`createVaultIdempotently`) already handled concurrent first writes, replay, request tampering, owner mismatches, and expired-claim reclamation. However, the surrounding HTTP boundary still trusted client state in ways that are unsafe for a user-funds feature:

1. **Actor identity was inferred from client state.** `actorUserId` was derived as `req.header('x-user-id') ?? req.body?.creator ?? req.user?.userId ?? 'unknown'`, so a hostile client could forge `x-user-id`/`creator` and have audit logs recorded under (or idempotency keys scoped to) another user's identity — a cross-user key-hijacking vector.
2. **Wrong-network payloads were accepted.** A client could supply any `onChain.networkPassphrase`, `contractId`, or `sourceAccount` verbatim, so a vault payload could be built/signed against a different network than the backend is configured for.
3. **Stored responses were replayed unvalidated.** A corrupt/truncated `vault_creation_idempotency.response` row (or a broken payload builder) could be forwarded to a client as if it were a valid vault.
4. **Route parameters were unvalidated.** `/:id` routes accepted arbitrary strings, and `/user/:address` accepted any string, before hitting the store.

## Changes

### `src/services/vaultValidation.ts`
- Added `getConfiguredNetworkPassphrase()` (env `SOROBAN_NETWORK_PASSPHRASE`, default testnet) and `isValidContractAddress()` (C… strkey format).
- Extended the `onChain` schema so a client-supplied `networkPassphrase` must match the configured network, `contractId` must be a valid C… address, and `sourceAccount` must be a valid G…/M… address. Wrong-network and malformed wallet inputs are rejected at the boundary before any write.
- Added `assertValidVaultCreateResponse()`: a shared shape guard for the server-generated response (`vault.id` present, `onChain.payload.method === 'create_vault'`). It fails closed on malformed responses.

### `src/services/vaultCreationIdempotency.ts`
- `parseResponse` now catches invalid JSON and shape-violating stored rows, throwing the new `VaultCreationMalformedResponseError` instead of replaying garbage from a corrupt reservation.

### `src/routes/vaults.ts`
- Actor identity (`resolveActorUserId`) now comes **only** from the verified principal (`req.user` / `req.apiKeyAuth`); the spoofable `x-user-id`/body fallback is gone, and a request with no verified principal is rejected `401` (disconnected-wallet boundary).
- `assertValidVaultCreateResponse` runs before the audit log / response on both the fresh-creation and replay paths.
- Added `requireValidVaultId` (UUID check → `400`) to `GET/PATCH /:id`, `/:id/timeline`, `/:id/cancel`, `/:id/dispute`, `/:id/resolve-dispute`, and a Stellar-address check → `400` on `GET /user/:address`.

### `src/types/vaults.ts`
- Added `retryable?: boolean` to the on-chain submission error shape (resolves a pre-existing `tsc` failure on main at `src/services/soroban.ts:1086`).

### Tests (focused, automated)
- **`src/routes/vaults.idempotency.test.ts`** (new): route-level coverage of success + key scoping, spoofed `x-user-id`/`creator` ignored for the audit actor, disconnected-wallet → 401, replay → 200, tampering → 409, owner mismatch → 409, in-progress → 409 retryable, invalid key → 400, wrong-network → 400, malformed built/stored responses → 500 fail-closed, and malformed route params → 400.
- **`src/services/vaultValidation.test.ts`**: unit tests for the `onChain` network/wallet/contract boundary and the response-shape guard.
- **`src/services/vaultCreationIdempotency.test.ts`**: durable (DB) path tests with a fake pg pool — replay from a stored row, and fail-closed on non-JSON / shape-violating stored responses.

## Acceptance criteria mapping

| Criterion | Where |
|---|---|
| Invariants enforced for normal and adversarial inputs | `createVaultSchema` refinements + `assertValidVaultCreateResponse` + coordinator `parseResponse` |
| Route parameters, wallet identity, network, numeric values, server responses validated at the boundary | `requireValidVaultId`, `/user/:address` strkey check, `onChain` schema (network/contract/source), existing amount/milestone bounds, response-shape guard |
| Ownership/authorization checked, not inferred from client state | `resolveActorUserId` (principal-only) + owner-bound coordinator + route tests proving spoofed headers are ignored |
| Replay, tampering, wrong-network, disconnected-wallet, malformed-response covered | `src/routes/vaults.idempotency.test.ts` + `src/services/vaultCreationIdempotency.test.ts` |
| Automated tests cover success, failure, boundary, retry, permission | All three test files (17 + 16 + 12 new cases) |

## Validation

Commands run locally (all green):

```bash
npm run build                       # tsc — passes (incl. fixing pre-existing soroban.ts type error)
npm test                            # 115 suites pass; 9 pre-existing DB/env-dependent suites fail on main too
npm run openapi:typecheck           # passes
npm run openapi:check               # docs/openapi.yaml up to date
node --experimental-vm-modules node_modules/jest/bin/jest.js src/routes/vaults.idempotency.test.ts src/services/vaultValidation.test.ts src/services/vaultCreationIdempotency.test.ts --runInBand  # 73/73 pass
```

Focused run: `npm run test:vault-validation` and:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js src/routes/vaults.idempotency.test.ts src/services/vaultValidation.test.ts src/services/vaultCreationIdempotency.test.ts
```

## Design tradeoffs

- **Network passphrase is pinned to server config.** Clients may omit `onChain.networkPassphrase` (the server fills it) or must match the configured network; a mismatch is `400`. This makes it impossible to build a vault payload for the wrong network via this API. The tradeoff: deployments that intentionally serve multiple networks must change `SOROBAN_NETWORK_PASSPHRASE` per environment — the schema intentionally does not support arbitrary client-chosen networks.
- **Contract-id validation is format-level** (`C…` strkey shape) rather than checksum-level because the pinned `@stellar/stellar-sdk` exposes no contract-strkey codec; this mirrors the existing `G…` regex check and is sufficient to reject injected garbage.
- **Malformed stored responses fail closed with a generic 500.** The route never leaks the stored row's contents; the coordinator throws `VaultCreationMalformedResponseError` and the route returns `Failed to create vault.` so a corrupt reservation cannot be replayed twice.
- **`prisma` is not used for the reservation table.** `vault_creation_idempotency` is owned by knex migrations (`db/migrations/20260827000100_…`); the Prisma schema mirrors only legacy models, and mixing two migration systems on one table would create drift risk. The reservation remains pg-backed via `src/db/pool.ts`.

## Remaining limitations / pre-existing CI failures

- `npm run lint` is broken repo-wide on `main` (≈2,900 pre-existing errors: the flat ESLint config defines no Jest/Node globals, unused imports, `any` usages). Lint is **not** part of CI (`.github/workflows/ci.yml` runs build, OpenAPI checks, migrations, and `npm test`), and none of the errors are introduced by this change.
- Nine Jest suites fail on clean `main` locally because they require the CI Postgres service (e.g. `migrations.rollback.test.ts`, `horizonReconciliation.test.ts`) or assert against pre-existing behavior (`errorHandler.test.ts` contract-error extraction, `timestamps.test.ts` message text). They fail identically on `main` before this change and are untouched here.
- `src/tests/idempotency.conflict.test.ts` (node:test runner, excluded from Jest) exercises the real router end-to-end against a database; it cannot run locally without Postgres but its expectations are preserved (principal-derived key scoping, 201/200/409 matrix).

## Non-goals respected

No typo-only, doc-only, formatting-only, or dependency-only changes; no tests removed; no secrets introduced; no unrelated refactors. The one extra fix (`retryable` in the submission-error type) is required for `npm run build` (a CI gate) to pass.
