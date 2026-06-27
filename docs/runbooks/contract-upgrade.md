# Accountability Vault Contract Upgrade Runbook

This runbook covers safe upgrades for the `accountability_vault` Soroban
contract, including WASM replacement, storage migration, verification, rollback,
and abort criteria. Use it before changing the contract WASM, contract spec,
persistent storage layout, emitted event schema, or backend contract address.

Related docs:
- [Vault contract/backend correlation](../contracts-accountability-vault.md)
- [Contract workspace README](../../contracts/README.md)
- [WASM size budget check](../../contracts/build-size-check.sh)
- [Pinned AccountabilityVault spec](../../contracts/accountability_vault/spec/AccountabilityVault.spec.json)
- [Stellar SDK upgrade process](../STELLAR_SDK_UPGRADE_PROCESS.md)

## Required Inputs

Collect these before the production window starts:

- Target environment: `testnet`, `futurenet`, or `public`.
- Current `SOROBAN_CONTRACT_ID`.
- Current backend release SHA and contract commit SHA.
- Current Horizon listener checkpoint for the contract.
- Source account that is authorized to deploy or upgrade the contract.
- The new optimized WASM artifact.
- The new generated contract spec.
- A test vault id that is safe to query on the target network.
- A rollback decision owner and the maximum outage window.

Never paste or commit `SOROBAN_SECRET_KEY`. Load it from the operator secret
store or a local shell session only.

## Pre-flight Gate

The upgrade is allowed to proceed only if every check in this section passes.

1. Freeze contract-affecting writes.

   Pause scheduled jobs and user flows that submit `create_vault`, `stake`,
   `check_in`, `claim`, `slash_on_miss`, or `withdraw`. Read-only API traffic can
   continue if the current contract and listener checkpoints remain stable.

2. Snapshot backend state.

   Capture the backend release, contract id, listener checkpoint, and a vault
   sample before any chain write:

   ```bash
   RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "artifacts/contract-upgrade/$RUN_ID"

   git rev-parse HEAD > "artifacts/contract-upgrade/$RUN_ID/backend-sha.txt"
   printf '%s\n' "$SOROBAN_CONTRACT_ID" > "artifacts/contract-upgrade/$RUN_ID/contract-id.before.txt"

   psql "$DATABASE_URL" \
     -c "copy (select * from horizon_checkpoints order by contract_address) to stdout with csv header" \
     > "artifacts/contract-upgrade/$RUN_ID/horizon-checkpoints.before.csv"

   psql "$DATABASE_URL" \
     -c "copy (select id, status, contract_id, updated_at from vaults order by updated_at desc limit 100) to stdout with csv header" \
     > "artifacts/contract-upgrade/$RUN_ID/vault-sample.before.csv"
   ```

3. Build the optimized WASM and enforce the size budget.

   ```bash
   cd contracts
   stellar contract build
   bash build-size-check.sh
   cp target/wasm32-unknown-unknown/release/accountability_vault.wasm \
     "../artifacts/contract-upgrade/$RUN_ID/accountability_vault.new.wasm"
   ```

   Abort if `build-size-check.sh` reports a size above the configured
   `MAX_WASM_SIZE` budget.

4. Run contract tests and snapshot checks.

   ```bash
   cd contracts/accountability_vault
   cargo test
   bash scripts/check_snapshots.sh
   ```

   Abort on any failing unit test or unexpected simulator snapshot change.

5. Diff the contract spec.

   ```bash
   cd contracts
   stellar contract inspect \
     --wasm target/wasm32-unknown-unknown/release/accountability_vault.wasm \
     > "../artifacts/contract-upgrade/$RUN_ID/AccountabilityVault.spec.new.json"

   git diff --no-index \
     accountability_vault/spec/AccountabilityVault.spec.json \
     "../artifacts/contract-upgrade/$RUN_ID/AccountabilityVault.spec.new.json"
   ```

   Some Stellar CLI versions expose this as
   `stellar contract info interface --wasm <wasm>`. Use the equivalent command
   for the installed CLI, but always capture the generated spec artifact.

   Abort if the diff changes any of these without an approved backend migration:

   - `create_vault` argument order or the `vault_id` argument.
   - Event topics consumed by `src/services/eventParser.ts`.
   - `get_vault` return shape.
   - Error codes documented in `docs/contract_errors.md`.
   - Any migration or upgrade method signature.

6. Confirm upgrade path from the spec.

   In-place upgrade is allowed only when the current or new spec exposes an
   admin-gated upgrade entrypoint and the authorized source account matches the
   configured contract admin or guardian policy. If no upgrade entrypoint exists,
   use the new-contract replacement path and update `SOROBAN_CONTRACT_ID`
   instead of attempting an in-place upgrade.

## Upgrade Authorization

Before sending any transaction:

- Confirm the source account is the intended contract admin or release operator.
- Confirm required multisig approvals or release approvals are recorded.
- Confirm the source account has enough XLM for fees and rent changes.
- Confirm the target network and RPC endpoint match the release window.
- Confirm the command uses the production artifact built in the pre-flight gate.

Recommended shell guard:

```bash
printf 'network=%s\ncontract=%s\nsource=%s\n' \
  "$SOROBAN_NETWORK" "$SOROBAN_CONTRACT_ID" "$SOROBAN_SOURCE_ACCOUNT"

test -n "$SOROBAN_NETWORK"
test -n "$SOROBAN_RPC_URL"
test -n "$SOROBAN_CONTRACT_ID"
test -n "$SOROBAN_SOURCE_ACCOUNT"
test -n "$SOROBAN_SECRET_KEY"
```

Abort if any variable is empty or points at the wrong network.

## Path A: In-place WASM Upgrade

Use this path only when the contract spec exposes a documented upgrade
entrypoint. The method name and argument names must come from the generated spec,
not from memory.

1. Install or stage the new WASM if the CLI requires an install step.

   ```bash
   stellar contract install \
     --wasm "artifacts/contract-upgrade/$RUN_ID/accountability_vault.new.wasm" \
     --source "$SOROBAN_SOURCE_ACCOUNT" \
     --network "$SOROBAN_NETWORK" \
     > "artifacts/contract-upgrade/$RUN_ID/install.txt"
   ```

   Capture the returned WASM hash as `NEW_WASM_HASH`.

2. Invoke the admin-gated upgrade entrypoint.

   ```bash
   stellar contract invoke \
     --id "$SOROBAN_CONTRACT_ID" \
     --source "$SOROBAN_SOURCE_ACCOUNT" \
     --network "$SOROBAN_NETWORK" \
     -- upgrade \
     --new_wasm_hash "$NEW_WASM_HASH" \
     > "artifacts/contract-upgrade/$RUN_ID/upgrade.txt"
   ```

   Replace `upgrade` and `new_wasm_hash` with the actual names from the spec if
   they differ.

3. Record the transaction hash, ledger, new WASM hash, and operator approval in
   the release ticket.

Abort if authorization fails, the RPC response is not successful, the returned
contract id changes unexpectedly, or the new hash does not match the staged
artifact.

## Path B: New Contract Replacement

Use this path when there is no safe in-place upgrade entrypoint, when the
storage migration is not backward compatible, or when the release intentionally
moves to a fresh contract id.

1. Deploy the new WASM on the target network.

   ```bash
   stellar contract deploy \
     --wasm "artifacts/contract-upgrade/$RUN_ID/accountability_vault.new.wasm" \
     --source "$SOROBAN_SOURCE_ACCOUNT" \
     --network "$SOROBAN_NETWORK" \
     > "artifacts/contract-upgrade/$RUN_ID/deploy.txt"
   ```

2. Initialize admin/token allowlist settings required by the new contract.

   ```bash
   NEW_CONTRACT_ID="$(tail -n 1 artifacts/contract-upgrade/$RUN_ID/deploy.txt)"

   stellar contract invoke \
     --id "$NEW_CONTRACT_ID" \
     --source "$SOROBAN_SOURCE_ACCOUNT" \
     --network "$SOROBAN_NETWORK" \
     -- init \
     --admin "$SOROBAN_SOURCE_ACCOUNT" \
     > "artifacts/contract-upgrade/$RUN_ID/init.txt"
   ```

   Use the exact initializer arguments from the generated spec.

3. Update backend configuration.

   Set `SOROBAN_CONTRACT_ID=$NEW_CONTRACT_ID`, restart the backend, and ensure
   the Horizon listener allowlist includes the new contract id. Keep the old
   checkpoint snapshot until event replay is verified.

Abort if deploy/init fails, the backend boot check reports Soroban as
misconfigured, or the listener cannot see the replacement contract.

## Storage Migration

Prefer schema-compatible changes that require no migration. If a migration is
required, it must be idempotent, versioned, and safe to resume after an RPC
timeout.

Required migration contract behavior:

- Store a migration version key in instance or persistent storage.
- Refuse to run when `from_version` is not the currently stored version.
- Process bounded batches when live vault data can exceed one transaction.
- Emit or return enough information to identify the migrated range.
- Update the version only after the batch has been written successfully.

Run one small batch first:

```bash
stellar contract invoke \
  --id "$SOROBAN_CONTRACT_ID" \
  --source "$SOROBAN_SOURCE_ACCOUNT" \
  --network "$SOROBAN_NETWORK" \
  -- migrate_storage \
  --from_version 1 \
  --to_version 2 \
  --limit 10 \
  > "artifacts/contract-upgrade/$RUN_ID/migrate-001.txt"
```

Then verify the sampled vaults before continuing larger batches. If the spec
does not contain `migrate_storage` or an equivalent approved method, do not run
a production storage migration.

Abort migration when:

- The method is not present in the generated spec.
- A batch changes a vault id, token, creator, verifier, amount, deadline, or
  milestone status unexpectedly.
- The migration cannot be re-run safely after a partial failure.
- The backend event parser rejects post-migration events.

## Post-upgrade Verification

Run these checks before unfreezing writes.

1. Query a known vault on-chain.

   ```bash
   stellar contract invoke \
     --id "$SOROBAN_CONTRACT_ID" \
     --source "$SOROBAN_SOURCE_ACCOUNT" \
     --network "$SOROBAN_NETWORK" \
     -- get_vault \
     --vault_id "$TEST_VAULT_ID" \
     > "artifacts/contract-upgrade/$RUN_ID/get-vault.after.txt"
   ```

2. Verify backend boot and Soroban submit configuration.

   ```bash
   npm test -- sorobanEnv.test.ts
   npm test -- sorobanBoot.test.ts
   npm test -- soroban.test.ts
   ```

3. Verify listener checkpoints.

   ```bash
   curl -sS "$API_BASE_URL/api/admin/horizon/listener" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     > "artifacts/contract-upgrade/$RUN_ID/listener.after.json"
   ```

   Confirm the listener is tracking the expected contract id and has not moved
   the cursor behind the snapshot ledger.

4. Verify event compatibility.

   Exercise at least one safe testnet lifecycle path (`create_vault`, `stake`,
   and one settlement path) and confirm emitted topics still parse into the
   backend event types.

5. Compare state samples.

   ```bash
   psql "$DATABASE_URL" \
     -c "copy (select id, status, contract_id, updated_at from vaults order by updated_at desc limit 100) to stdout with csv header" \
     > "artifacts/contract-upgrade/$RUN_ID/vault-sample.after.csv"

   diff -u \
     "artifacts/contract-upgrade/$RUN_ID/vault-sample.before.csv" \
     "artifacts/contract-upgrade/$RUN_ID/vault-sample.after.csv"
   ```

   Expected differences should match the deliberate testnet or migration
   actions only.

## Rollback

Rollback must be decided before unfreezing writes.

For an in-place upgrade:

- If no storage migration has run, invoke the same admin-gated upgrade entrypoint
  with the previous WASM hash.
- Re-run the post-upgrade verification against the previous hash.
- Keep the release frozen until the listener status is healthy.

For a new-contract replacement:

- Restore the previous `SOROBAN_CONTRACT_ID` in backend configuration.
- Restart the backend.
- Restore the listener allowlist to the previous contract id.
- Reset or replay the Horizon checkpoint from
  `horizon-checkpoints.before.csv` only after confirming no events from the new
  contract need to be preserved.

For a storage migration:

- If the migration includes an audited rollback entrypoint, run it in the same
  bounded-batch style as the forward migration.
- If no rollback entrypoint exists and any persistent writes have occurred,
  keep writes frozen, keep both before/after artifacts, and escalate to the
  release owner. On-chain snapshots are evidence for reconstruction; they do not
  undo chain writes by themselves.

Do not continue forward after a failed rollback attempt without a new release
approval.

## Hard Abort Criteria

Abort the upgrade immediately when any of these are true:

- The optimized WASM exceeds the size budget.
- The generated spec diff is unexplained or not approved.
- `vault_id` correlation changes.
- Required Soroban env vars are missing or target the wrong network.
- The source account is not the approved admin/operator.
- The dry-run cannot query a known test vault after deploy/upgrade.
- A migration batch is not idempotent.
- Backend Soroban tests fail.
- The Horizon listener cannot report or preserve the expected contract
  checkpoint.
- Any command returns a failed transaction, unknown status, or partial write that
  the runbook cannot classify.

## Dry-run Evidence Template

Attach this table to the PR or release ticket after running the testnet dry-run.

| Step | Command/artifact | Expected result | Captured result |
| --- | --- | --- | --- |
| Build | `stellar contract build` | Optimized WASM created | |
| Size budget | `bash build-size-check.sh` | Within `MAX_WASM_SIZE` | |
| Tests | `cargo test` | All contract tests pass | |
| Spec diff | `git diff --no-index ...` | Only approved changes | |
| Deploy/upgrade | `deploy.txt` or `upgrade.txt` | Successful tx hash | |
| Migration | `migrate-001.txt` | Version advances or no-op | |
| Readback | `get-vault.after.txt` | Existing vault decodes | |
| Listener | `listener.after.json` | Expected contract/checkpoint | |
| Backend tests | `npm test -- soroban*.test.ts` | All relevant tests pass | |

Store artifacts under `artifacts/contract-upgrade/<RUN_ID>/`. Do not commit
secrets, private keys, admin tokens, or production database dumps.
