# Soroban Contract Upgrade & Storage Migration Runbook

This document describes the safe, auditable procedure for upgrading the `accountability_vault` Soroban contract and migrating persistent storage. It includes pre-flight checks, rollback paths, and post-upgrade verification.

## Prerequisites

- `soroban-cli` installed and configured for the target network
- Contract upgrade authority (admin) key available in your wallet
- Current contract address and WASM hash
- Test environment configured (for dry-runs)
- Read the [Accountability Vault Contract Documentation](contracts-accountability-vault.md) for background on storage layout

## Pre-Flight Checks (Mandatory)

### 1. Snapshot Current State

Take a snapshot of all active vaults:
```bash
soroban contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source <YOUR_ACCOUNT> \
  --network <NETWORK> \
  -- \
  get_vault \
  --vault_id <VAULT_ID>
```

Repeat for all known vaults and save output to `vault_snapshots_<DATE>.json`.

### 2. Verify Build Size

Ensure the new WASM stays within the network limit:
```bash
cd contracts/accountability_vault
cargo build --release --target wasm32-unknown-unknown
du -h target/wasm32-unknown-unknown/release/accountability_vault.wasm
```

The size must not exceed 1MB (network limit as of 2026).

### 3. Validate Spec Diff

Compare the new contract spec with the current one:
```bash
# Generate spec for new version
soroban contract specs \
  --wasm target/wasm32-unknown-unknown/release/accountability_vault.wasm \
  --output new_spec.json

# Compare with existing spec
diff spec/AccountabilityVault.spec.json new_spec.json
```

Any breaking changes (removed endpoints, changed parameter order/type) must be reviewed and documented.

### 4. Ensure No Active Disputes

Verify no vaults are in `Disputed` state before upgrading:
```bash
# Check vaults via your backend or direct contract calls
```

## Upgrade Procedure

### Step 1: Deploy New WASM

Deploy the new contract WASM (this does **not** upgrade the existing contract yet):
```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/accountability_vault.wasm \
  --source <ADMIN_ACCOUNT> \
  --network <NETWORK>
```

Save the returned WASM hash as `NEW_WASM_HASH`.

### Step 2: Upgrade Contract

Upgrade the existing contract to use the new WASM:
```bash
soroban contract upgrade \
  --id <CONTRACT_ADDRESS> \
  --source <ADMIN_ACCOUNT> \
  --network <NETWORK> \
  --wasm-hash <NEW_WASM_HASH>
```

### Step 3: Storage Migration (if needed)

If the new contract requires storage migration, invoke the migration function:
```bash
soroban contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source <ADMIN_ACCOUNT> \
  --network <NETWORK> \
  -- \
  migrate
```

## Post-Upgrade Verification

### 1. Verify Contract Version
Check that the new WASM is active:
```bash
soroban contract inspect \
  --id <CONTRACT_ADDRESS> \
  --network <NETWORK>
```

### 2. Validate Vault State
For each vault in your snapshot:
- Call `get_vault` and confirm state matches snapshot
- Test a non-critical operation (e.g., reading milestones)

### 3. Test Happy Path
Create a test vault, stake, check in, and claim to verify full functionality.

## Rollback Procedure

If issues are detected post-upgrade:

### 1. Emergency Pause (if needed)
Pause affected vaults first:
```bash
soroban contract invoke \
  --id <CONTRACT_ADDRESS> \
  --source <GUARDIAN_ACCOUNT> \
  --network <NETWORK> \
  -- \
  emergency_pause \
  --vault_id <VAULT_ID> \
  --guardian <GUARDIAN_ADDRESS>
```

### 2. Revert to Previous WASM
Upgrade back to the known-good WASM hash:
```bash
soroban contract upgrade \
  --id <CONTRACT_ADDRESS> \
  --source <ADMIN_ACCOUNT> \
  --network <NETWORK> \
  --wasm-hash <OLD_WASM_HASH>
```

### 3. Verify Rollback
Repeat verification steps with the old contract.

## Abort Criteria

Stop the upgrade immediately and rollback if:
- Pre-flight spec check reveals untested breaking changes
- Build size exceeds network limit
- Post-upgrade verification fails for any vault
- Storage migration errors occur

## Audit Trail

All upgrades and rollbacks must be documented in:
- Git commit history
- Change management ticket
- Operations log

Include:
- Date/time
- Operator
- Old and new WASM hashes
- Reason for upgrade/rollback
- Vault snapshot links
- Verification results
