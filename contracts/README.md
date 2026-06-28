# Disciplr Soroban Contracts

On-chain programmable, time-locked capital vaults for accountability staking,
the chain-side counterpart to the `disciplr-backend` API and Horizon listener.

## Workspace layout

```text
contracts/
├── Cargo.toml                       # workspace manifest (soroban-sdk = "23")
├── README.md
└── accountability_vault/
    ├── Cargo.toml
    └── src/
        ├── lib.rs                   # AccountabilityVault contract
        └── test.rs                  # unit tests (testutils)
```

## accountability_vault

Implements the vault lifecycle that the backend models off-chain in
`src/services/vaultTransitions.ts` and parses events for in
`src/services/eventParser.ts`:

| Function | Purpose |
|---|---|
| `create_vault` | Create a `Draft` vault with milestones, verifier, and success/failure destinations. Validates amount, deadline, that milestone amounts sum to the total, and rejects obviously-degenerate salt/vault_id values (all-zero or all-ones `BytesN<32>`). |
| `stake` | Creator transfers the SEP-41 token into the contract; `Draft` -> `Active`. |
| `check_in` | Designated verifier confirms a milestone before its `due_date`. |
| `slash_on_miss` | After the deadline with unverified milestones, slash funds to `failure_destination`; `Active` -> `Failed`. |
| `claim` | When all milestones are verified, release funds to `success_destination`; `Active` -> `Completed`. |
| `withdraw` | Cancel/refund an unfunded or unstarted vault to the creator; -> `Cancelled`. |
| `get_vault` | Read-only accessor for the current vault record. |
| `get_unverified_milestone_indices` | Returns `Vec<u32>` of indices for milestones that have not yet been verified, in ascending order. Used by the keeper job (`src/jobs/handlers.ts`) to determine slash targets without loading and filtering the full vault client-side. |

### Token allowlist policy

`accountability_vault` enforces a deployment-wide token allowlist at vault
creation time. The admin initializes the contract with `init`, then uses
`set_allowed_token(admin, token, true)` to permit curated SEP-41 token
contracts (for example an XLM SAC or approved USDC contract) and
`set_allowed_token(admin, token, false)` to remove them. `create_vault` checks
the selected token against the instance-level `AllowedToken(token)` storage
entry and returns `Error::TokenNotAllowed` when the token is absent or has been
removed. Removing a token only blocks future vault creation; existing vault
records retain their configured token so already-created vaults can continue
their lifecycle.

The `VaultStatus` enum (`Draft`/`Active`/`Completed`/`Failed`/`Cancelled`)
mirrors `PersistedVault.status` in `src/types/vaults.ts`. Emitted events
(`vault_created`, `vault_staked`, `vault_funded`, `milestone_checked_in`, `vault_slashed`,
`vault_completed`, `vault_cancelled`, `vault_withdrawn`) align with the topics
consumed by the backend event parser.

### Error Handling & Precise Deadline Errors
To allow the backend to render precise, unambiguous user-facing errors:
- **`Error::DeadlineInPast` (28)**: Returned when the configured `end_timestamp` is less than or equal to the current ledger timestamp.
- **`Error::InvalidDeadline` (4)**: Reserved strictly for structural mismatches (such as a milestone `due_date` exceeding `end_timestamp` or non-monotonic due-date ordering).

## Build & test

```bash
# from the contracts/ directory
stellar contract build
cargo test

# Check that the compiled contract stays within the allowed size budget
# Fails if the .wasm artifact exceeds the 100KB budget (configurable via MAX_WASM_SIZE)
bash build-size-check.sh
```

### Wasm Size Budget Configuration

To prevent accidental bloat in the smart contract, the `accountability_vault` includes a size budget check (`build-size-check.sh`) integrated into the CI pipeline.
The default limit is set to **100,000 bytes** (~100KB).

If you need to update this budget as the contract grows:

1. Temporarily increase the budget locally by exporting the variable: `export MAX_WASM_SIZE=150000`
2. Update the default value in `contracts/build-size-check.sh`
3. Push the changes to update the CI limit.

## Backend integration

These rules are enforced through boundary and idempotency tests in `contracts/accountability_vault/src/test.rs`.

# Disciplr Smart Contracts

## Accountability Vault

### Overview

The Accountability Vault contract enables users to create time-locked capital vaults with milestone-based accountability. Funds are released only when all milestones are validated by assigned verifiers.

### Token Decimals Validation

**Supported range: 0 to 18 decimals**

The `create_vault` function validates that the deposited token's `decimals()` value falls within the supported range `[0, 18]`. Tokens with decimals outside this range are rejected with `Error::UnsupportedTokenDecimals`.

#### Rationale

1. **Backend Compatibility**: The backend service (`src/services/soroban.ts`) assumes a fixed decimals contract. Supporting arbitrary decimals would require dynamic scaling throughout the API.

2. **JavaScript Precision**: JavaScript's `Number` type uses IEEE 754 double-precision floats, which lose integer precision beyond 2^53 (~15-16 decimal digits). Tokens with &gt;18 decimals could cause rounding errors in the frontend.

3. **Ecosystem Standard**: The Stellar ecosystem standardizes on 7 decimals for native assets, and ERC-20 tokens on Ethereum cap at 18 decimals. This range covers all practical use cases.

4. **Security**: Extremely high decimal values (e.g., 255) could be used in overflow attacks or to exploit precision loss in calculations.

#### Error Handling

| Error Code | Value | Condition |
|------------|-------|-----------|
| `UnsupportedTokenDecimals` | 400 | `token.decimals() &lt; 0 \|\| token.decimals() &gt; 18` |

#### Example

```rust
// Valid: 7 decimals (Stellar native)
let token = create_token(7);
client.create_vault(&creator, &token, &100, ...); // ✓ Success

// Invalid: 19 decimals
let token = create_token(19);
client.create_vault(&creator, &token, &100, ...); // ✗ UnsupportedTokenDecimals

Constants
pub const MIN_TOKEN_DECIMALS: u32 = 0;
pub const MAX_TOKEN_DECIMALS: u32 = 18;

Contract Methods
| Method                      | Description                            | Auth Required         |
| --------------------------- | -------------------------------------- | --------------------- |
| `initialize(admin)`         | Set contract admin                     | Admin                 |
| `create_vault(...)`         | Create new vault with token validation | Creator               |
| `validate_milestone(...)`   | Validate a milestone                   | Verifier              |
| `cancel_vault(vault_id)`    | Cancel vault and return funds          | Creator/Admin         |
| `slash_vault(vault_id)`     | Slash vault after deadline             | Anyone (after expiry) |
| `get_vault(vault_id)`       | Query vault state                      | None                  |
| `get_token_decimals(token)` | Get cached token decimals              | None                  |


Testing
# Run all tests
cargo test

#### Logs-enabled release profile

The crate defines a `release-with-logs` profile in `contracts/Cargo.toml` that inherits
from `release` and enables `debug-assertions`. This allows diagnostics to be compiled
only for simulator-focused, release-mode builds while keeping the production `release`
build log-free.

```bash
cd contracts/accountability_vault
cargo test --profile release-with-logs
cargo build --profile release-with-logs --target wasm32-unknown-unknown
```

### Migration: API change (cancel_vault vs withdraw)

Deployment
# Build
cargo build --target wasm32-unknown-unknown --release

# Deploy (testnet)
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/accountability_vault.wasm \
  --source alice \
  --network testnet


Architecture
  graph TD
    A[User] -->|create_vault| B[AccountabilityVault]
    B -->|validate decimals| C[TokenClient::decimals]
    C -->|0-18| D[Accept]
    C -->|>18| E[Reject: UnsupportedTokenDecimals]
    D -->|transfer| F[Token Contract]
    G[Verifier] -->|validate_milestone| B
    B -->|all validated| H[Release to success_destination]
    B -->|expired| I[Slash to failure_destination]


---

## 4. `src/services/soroban.ts` (Backend — Document Assumption)

```typescript
/**
 * Soroban Service
 * 
 * Handles on-chain interactions with the Accountability Vault smart contract.
 * 
 * IMPORTANT: This service assumes all tokens use a fixed decimal precision.
 * The smart contract enforces this by rejecting tokens with decimals outside
 * [0, 18] in `create_vault`. See contracts/accountability_vault/src/lib.rs
 * for the validation logic.
 * 
 * If you need to support tokens with different decimals, update both:
 * 1. This service (dynamic scaling)
 * 2. The smart contract (adjust MIN_TOKEN_DECIMALS / MAX_TOKEN_DECIMALS)
 */

import { Contract, SorobanRpc, TransactionBuilder, Networks } from '@stellar/stellar-sdk';

// Fixed decimal assumption - matches contract validation
// All amounts are handled as raw integer values (smallest unit)
// Display formatting should divide by 10^decimals for UI
const ASSUMED_DECIMALS = 7; // Stellar native standard

export class SorobanService {
  private rpc: SorobanRpc.Server;
  private contract: Contract;
  
  constructor(contractId: string, rpcUrl: string) {
    this.rpc = new SorobanRpc.Server(rpcUrl);
    this.contract = new Contract(contractId);
  }
  
  /**
   * Create a vault on-chain
   * 
   * Note: The contract validates token decimals. If the token has
   * unsupported decimals, the transaction will fail with
   * Error::UnsupportedTokenDecimals (error code 400).
   */
  async createVault(params: CreateVaultParams): Promise<string> {
    // ... existing implementation ...
  }
}

`src/services/soroban.ts` calls `create_vault` via the Stellar SDK
(`@stellar/stellar-sdk` v14). The Horizon listener
(`src/services/horizonListener.ts`) and `src/services/eventParser.ts`
ingest the events emitted by these functions to keep the off-chain vault state
in sync.

## Upgrade & Dependency Pinning Policy

To ensure deterministic builds and avoid silent feature or semantic changes between local development, staging environments, and CI, `soroban-sdk` is strictly pinned to an exact minor/patch version in the workspace root `contracts/Cargo.toml`:
```toml
[workspace.dependencies]
soroban-sdk = "=23.0.1"
```

### Dependency Bump Guidelines:
1. **Deliberate upgrades only**: Never use caret (`^`) or generic major-only ranges (`"23"`) for key core compiler/SDK crates like `soroban-sdk`.
2. **Review release changelogs**: Ensure you review Soroban SDK changelogs before upgrading to check for changes in host functions, resource budgets, or gas/memory metering.
3. **Regenerate lockfile**: When changing the pinned version, run `cargo update` inside the `contracts` directory to strictly lock dependencies and refresh `contracts/Cargo.lock`.

