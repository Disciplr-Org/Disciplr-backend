# Disciplr Smart Contracts

This directory contains Soroban smart contracts for the Disciplr platform.

## Accountability Vault

The `accountability_vault` contract implements time-locked capital vaults on Stellar with milestone-based release conditions.

### Overview

The accountability vault allows users to:
- Lock funds in a vault with a total amount
- Define milestones with individual amounts that must sum to the total
- Specify a verifier authorized to validate milestone completion
- Set success and failure destinations for fund release
 - Allow reclaiming residual (dust) token balances to the creator after settlement

### Arithmetic Safety

**Critical Security Feature: Overflow-Safe Amount Summation**

The `create_vault` function implements overflow-safe arithmetic for milestone amount summation to prevent integer overflow attacks and unexpected panics.

#### Implementation Details

- **Location**: `accountability_vault/src/lib.rs` in the `create_vault` function
- **Method**: Uses `checked_add` instead of `+=` for all i128 arithmetic operations
- **Error Handling**: Returns `Error::Overflow` on overflow instead of panicking
- **Invariant**: Maintains `sum == amount` invariant after successful validation

#### Code Example

```rust
// Sum milestone amounts using checked_add to prevent overflow
let mut sum: i128 = 0;
for milestone in milestones.iter() {
    // Use checked_add to detect overflow and return typed error instead of panicking
    sum = match sum.checked_add(milestone.amount) {
        Some(result) => result,
        None => {
            // Overflow occurred - return typed error instead of panicking
            return Err(Error::Overflow);
        }
    };
}
```

#### Why This Matters

1. **Security**: Prevents integer overflow attacks that could bypass amount validation
2. **Reliability**: Returns typed errors instead of panicking, allowing graceful error handling
3. **Predictability**: Ensures the contract behaves consistently even with extreme input values
4. **Auditability**: Clear error types make security reviews easier

#### Test Coverage

The contract includes comprehensive tests for overflow scenarios:
- `test_create_vault_overflow_extreme_amounts`: Tests overflow with multiple large milestones
- `test_create_vault_overflow_single_large_milestone`: Tests overflow with two large milestones
- `test_create_vault_large_valid_amounts`: Verifies large but valid amounts work correctly

All tests ensure that:
- Overflow returns `Error::Overflow` instead of panicking
- Valid large amounts are processed correctly
- The `sum == amount` invariant is maintained

### Error Types

The contract defines the following error types:

- `InvalidAmount`: Negative or zero amounts provided
- `AmountMismatch`: Milestone amounts don't sum to total vault amount
- `Overflow`: Integer overflow occurred during amount summation

### Performance & Gas Benchmarks

To ensure predictable scaling and prevent out-of-gas exploits or transaction failures, the contract has built-in performance bounds.

#### Storage Reads & Complexity Analysis
- **Milestone Iteration**: Functions like `claim` and `slash_on_miss` iterate over the `milestones` vector to sum release amounts and check status. CPU and Memory usage scale linearly ($O(N)$) with the milestone count $N$.
- **Flat Storage Access**: The storage layout guarantees flat ($O(1)$) read footprint. There are no redundant storage reads or nested lookups within loops.
- **Gas Bounded Growth**: The CPU and Memory bounds are actively asserted in test suites to catch regressions before deployment.

#### Documented Footprint Thresholds (10 Milestones Baseline)
Using Soroban's native budget tracking (`Env::budget()`), the performance metrics for a representative 10-milestone vault are capped as follows:

| Function | CPU Cost Threshold (Instructions) | Memory Cost Threshold (Bytes) | Storage Read Footprint |
|----------|----------------------------------|-------------------------------|------------------------|
| `create_vault` | < 600,000 | < 200,000 | $O(1)$ Flat |
| `stake` | < 700,000 | < 200,000 | $O(1)$ Flat |
| `check_in` | < 300,000 | < 100,000 | $O(1)$ Flat |
| `claim` | < 900,000 | < 250,000 | $O(1)$ Flat |
| `slash_on_miss`| < 900,000 | < 250,000 | $O(1)$ Flat |

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

#### Test Coverage

The contract maintains >95% test coverage including:
- Normal vault creation
- Invalid amount validation
- Amount mismatch detection
- Overflow scenarios with extreme values
- Edge cases (empty milestones, zero amounts, negative amounts)

### Deployment

Deploy the contract to Soroban testnet or mainnet using the Soroban CLI:

```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/accountability_vault.wasm \
  --source <your-secret-key> \
  --network <network-passphrase>
```

### Security Considerations

1. **Overflow Protection**: All arithmetic operations use checked arithmetic
2. **Input Validation**: All amounts are validated for positivity
3. **Invariant Enforcement**: Milestone amounts must exactly sum to total vault amount
4. **Error Handling**: Typed errors prevent information leakage through panics

### Residual Sweep (reclaim_after_settlement)

The contract exposes `reclaim_after_settlement` to sweep any residual token
balance (dust or rounding remainders) held by the contract back to the vault
creator. Requirements:

- Caller must be the vault `creator` (authorization enforced via `Address::require_auth`).
- The vault must have no staked funds remaining (`amount == 0`).

The function queries the contract's token balance via `TokenClient::balance`
and performs a `TokenClient::transfer` of the full balance to the creator.

Location: `accountability_vault/src/lib.rs` — `Contract::reclaim_after_settlement`

### License

See main repository license file.
