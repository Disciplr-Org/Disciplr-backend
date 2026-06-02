# Disciplr Smart Contracts

This directory contains Soroban smart contracts for the Disciplr platform.

## Accountability Vault

The `accountability_vault` contract implements time-locked capital vaults on Stellar with milestone-based release conditions.

### Overview

The accountability vault allows users to:
- Host multiple independent vaults on a single contract deployment, keyed by a unique `vault_id`
- Lock funds in a vault with a total amount
- Define milestones with individual amounts that must sum to the total
- Specify a set of verifiers (M-of-N threshold) authorized to validate milestone completion
- Set a guardian address that can pause/unpause the vault in emergencies
- Set success and failure destinations for fund release
- Allow reclaiming residual (dust) token balances to the creator after settlement

### Security Invariants

#### Checks-Effects-Interactions (CEI) Pattern

`slash_on_miss`, `claim`, and `withdraw` (active-vault path) all update and persist vault
state — setting `status` to the terminal value and zeroing `staked` — **before** executing
the external `token::Client::transfer` call. This ensures the vault reaches a terminal state
even if the downstream token call panics or re-enters the contract.

```rust
// CEI: capture transfer values, update and persist state, then call external token.
let slashed = vault.staked;
let failure_destination = vault.failure_destination.clone();
vault.status = VaultStatus::Failed;
vault.staked = 0;
env.storage().instance().set(&DataKey::Vault, &vault);   // ← state committed

token::Client::new(&env, &token_addr).transfer(          // ← external call last
    &env.current_contract_address(),
    &failure_destination,
    &slashed,
);
```

#### Emergency Pause (Guardian Role)

A `guardian` address is set at `create_vault` time. The guardian may call:

- `emergency_pause(guardian)` — blocks `slash_on_miss`, `claim`, and active-vault
  `withdraw` while a dispute or incident is investigated.
- `emergency_unpause(guardian)` — re-enables normal operations.

Only the address stored as `vault.guardian` may call these functions; any other address is
rejected with `Error::Unauthorized`. Draft-vault cancellation via `withdraw` is not affected
by the pause flag, as it involves no token transfer.

#### M-of-N Verifier Approvals

`check_in` supports a configurable set of verifiers and an `approval_threshold` (M-of-N).
A milestone is flipped to `verified` only once at least `approval_threshold` distinct
addresses from the verifier set (or the optional oracle) have approved it.

- Double-approval by the same address returns `Error::AlreadyApproved`.
- Approvals are tracked per-milestone in `DataKey::MilestoneApprovals(index)`.
- The threshold must be ≥ 1 and ≤ `verifiers.len()`; otherwise `create_vault` returns
  `Error::InvalidThreshold`.

### Arithmetic Safety

The `create_vault` function validates that milestone amounts are positive and sum exactly to
the declared `amount`, rejecting mismatches with `Error::AmountMismatch`.

### Error Types

| Code | Name | Meaning |
|------|------|---------|
| 1 | `AlreadyInitialized` | Vault storage already set |
| 2 | `NotInitialized` | Vault not yet created |
| 3 | `InvalidAmount` | Zero or negative amount |
| 4 | `InvalidDeadline` | Deadline in the past or milestone exceeds vault end |
| 5 | `NoMilestones` | Empty milestone list |
| 6 | `NotDraft` | Expected Draft state |
| 7 | `NotActive` | Expected Active state |
| 8 | `Unauthorized` | Caller not permitted |
| 9 | `AlreadyStaked` | Vault already funded |
| 10 | `MilestoneIndexOutOfRange` | Index beyond milestone list |
| 11 | `MilestoneAlreadyVerified` | Milestone already at threshold |
| 12 | `DeadlinePassed` | Operation rejected after deadline |
| 13 | `DeadlineNotReached` | Slash attempted before deadline |
| 14 | `MilestonesIncomplete` | Not all milestones verified |
| 15 | `NothingToWithdraw` | Staked balance is zero |
| 16 | `AmountMismatch` | Received amount less than declared |
| 17 | `InsufficientAllowance` | Spender allowance below vault amount |
| 18 | `Paused` | Operation blocked by guardian pause |
| 19 | `AlreadyApproved` | Address has already approved this milestone |
| 20 | `NoVerifiers` | Empty verifier list |
| 21 | `InvalidThreshold` | Threshold is 0 or exceeds verifier count |
| 22 | `StakedRemaining` | Reclaim attempted while stake is non-zero |

### Performance & Gas Benchmarks

To ensure predictable scaling and prevent out-of-gas exploits or transaction failures, the
contract has built-in performance bounds.

#### Storage Reads & Complexity Analysis

- **Milestone Iteration**: Functions like `claim` and `slash_on_miss` iterate over the
  `milestones` vector. CPU and Memory usage scale linearly (O(N)) with the milestone count N.
- **Flat Storage Access**: The storage layout guarantees flat (O(1)) read footprint. There
  are no redundant storage reads or nested lookups within loops.
- **Gas Bounded Growth**: CPU and Memory bounds are actively asserted in test suites to
  catch regressions before deployment.

#### Documented Footprint Thresholds (10 Milestones Baseline)

| Function | CPU Cost Threshold (Instructions) | Memory Cost Threshold (Bytes) |
|----------|----------------------------------|-------------------------------|
| `create_vault` | < 600,000 | < 200,000 |
| `stake` | < 700,000 | < 200,000 |
| `check_in` | < 300,000 | < 100,000 |
| `claim` | < 900,000 | < 250,000 |
| `slash_on_miss` | < 900,000 | < 250,000 |

### Building and Testing

#### Prerequisites

- Rust 1.70+ with `wasm32-unknown-unknown` target
- Soroban CLI tools

#### Build

```bash
cd contracts/accountability_vault
cargo build --release --target wasm32-unknown-unknown
```

#### Test

```bash
cd contracts/accountability_vault
cargo test
```

#### Formatting

The workspace ships a `contracts/rustfmt.toml` config. Format all contract sources with:

```bash
cd contracts
cargo fmt
```

#### Lint

The workspace enables `clippy::all` warnings via `[workspace.lints.clippy]` in
`contracts/Cargo.toml`. Run clippy with warnings treated as errors:

```bash
cd contracts
cargo clippy -- -D warnings
```

To suppress known false-positives in generated Soroban SDK code, add
`#[allow(clippy::...)]` at the item level rather than disabling workspace-wide.

#### Test Coverage

The contract maintains comprehensive test coverage including:

- Normal vault lifecycle (create, stake, check-in, claim, slash, withdraw)
- CEI ordering invariants: terminal state committed before token transfer
- Emergency pause/unpause: guardian blocks and re-enables settlement paths
- M-of-N verifier approvals: partial approvals, full threshold, double-approval rejection
- Allowance-based staking (`stake_from`)
- Oracle-driven milestone verification
- Joint deadline extension (`extend_deadline`)
- Gas benchmarks with hard CPU/memory bounds

### Deployment

Deploy the contract to Soroban testnet or mainnet using the Soroban CLI:

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/accountability_vault.wasm \
  --source <your-secret-key> \
  --network <network-passphrase>
```

### Security Considerations

1. **CEI Pattern**: All token transfers occur after state is persisted to storage.
2. **Emergency Pause**: Guardian can halt settlement paths during disputes.
3. **M-of-N Verification**: No single verifier can unilaterally release funds when
   `approval_threshold > 1`.
4. **Overflow Protection**: Milestone amount summation uses safe integer arithmetic.
5. **Input Validation**: All amounts validated for positivity; milestone amounts must sum
   exactly to the vault amount.
6. **Authorized Operations**: Creator, verifier set, guardian, and oracle roles are
   enforced via `Address::require_auth()`.

### Residual Sweep (reclaim_after_settlement)

The contract exposes `reclaim_after_settlement(token_address)` to sweep any residual token
balance (dust or rounding remainders) held by the contract back to the vault creator.

Requirements:

- Caller must be the vault `creator` (authorization enforced via `require_auth`).
- The vault must have no staked funds remaining (`staked == 0`); otherwise
  `Error::StakedRemaining` is returned.

The function queries the contract's token balance via `token::Client::balance` and performs
a `token::Client::transfer` of the full balance to the creator.

Location: `accountability_vault/src/lib.rs` — `AccountabilityVault::reclaim_after_settlement`

### License

See main repository license file.
