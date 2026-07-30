# Stellar SDK v14 Upgrade Process

## Overview

The Stellar SDK is a critical dependency for Soroban contract interaction and horizon event parsing. This document describes the process for upgrading `@stellar/stellar-sdk` and validating that breaking changes surface early in development.

## Test Suite

**File:** [stellarSdkRegression.test.ts](../stellarSdkRegression.test.ts)

The regression suite pins the following SDK exports to detect breaking changes:

### Soroban Submission (src/services/soroban.ts)
- `Keypair` — Account signing; `Keypair.fromSecret()`, `Keypair.random()`
- `Contract` — Soroban contract invocation; `Contract.call(...)`
- `TransactionBuilder` — Transaction construction; `addOperation()`, `setTimeout()`, `build()`
- `Account` — Account management
- `nativeToScVal` — Convert native JS values to Soroban contract arguments
- `rpc.Server` — Soroban RPC client; `getAccount()`, `prepareTransaction()`, `sendTransaction()`, `getTransaction()`
- `Networks` — Network passphrases (PUBLIC, TESTNET, etc.)
- `BASE_FEE` — Base transaction fee constant

### Event Parsing (src/services/eventParser.ts)
- `xdr` — XDR codec for contract values
- `xdr.ScVal.fromXDR()` — Decode base64-encoded contract values
- `scValToNative` — Convert Soroban contract values to native JS types

## Running the Tests

### Single Run
```bash
npm test -- stellarSdkRegression.test.ts
```

### Watch Mode
```bash
npm test -- stellarSdkRegression.test.ts --watch
```

### Verbose Output
```bash
npm test -- stellarSdkRegression.test.ts --verbose
```

### In CI
The test is automatically included in the default Jest run:
```bash
npm test
```

All tests in `**/*.test.ts` are executed, including this suite.

## Upgrade Procedure

### 1. Prepare a Patch Release

Before upgrading the SDK, prepare a release branch:

```bash
git checkout -b chore/stellar-sdk-upgrade-v14.X
```

### 2. Upgrade the Dependency

Update `package.json`:

```bash
npm install @stellar/stellar-sdk@latest
```

Or specify a version:

```bash
npm install @stellar/stellar-sdk@^14.6.0
```

### 3. Run the Regression Suite

```bash
npm test -- stellarSdkRegression.test.ts
```

**Expected outcome:** All 34 tests pass.

If any test fails, the SDK contains a breaking change that requires code migration. See [Understanding Failures](#understanding-failures).

### 4. Run Full Test Suite

Ensure no other tests break:

```bash
npm test
```

### 5. Test Integration Manually (Optional)

If the SDK upgrade involves major version changes, manually test the Soroban submission flow:

```bash
# Set Soroban env vars
export SOROBAN_CONTRACT_ID="your-contract-id"
export SOROBAN_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export SOROBAN_SOURCE_ACCOUNT="your-account-id"
export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
export SOROBAN_SECRET_KEY="your-secret-key"

# Build and deploy
npm run build
npm run dev  # Test against testnet if configured
```

### 6. Commit Changes

Once all tests pass:

```bash
git add -A
git commit -m "chore: upgrade Stellar SDK to v14.X.Y"
git push origin chore/stellar-sdk-upgrade-v14.X
```

### 7. Create Pull Request

Create a PR with:
- Dependency update in `package.json`
- Test results showing all tests pass
- Any code migration notes (if breaking changes were encountered)

## Understanding Failures

### Contract API Changes

If Contract construction or `.call()` signature changes:

```
Expected: Contract constructor to accept string contract ID
Received: Contract requires Address object
```

**Migration steps:**
1. Locate all `new Contract(contractId)` calls (primarily in `src/services/soroban.ts`)
2. Wrap contract IDs with the new API signature
3. Update type definitions if necessary

### XDR Conversion Failures

If `xdr.ScVal.fromXDR()` or `scValToNative()` changes:

```
Expected: xdr.ScVal.fromXDR to decode base64 XDR data
Received: Method expects different format
```

**Migration steps:**
1. Review the new SDK API documentation
2. Update decoding logic in `src/services/eventParser.ts`
3. Adjust test constants in `stellarSdkRegression.test.ts` to match new signatures

### Transaction Builder Changes

If `TransactionBuilder` or transaction signing changes:

```
Expected: tx.sign(keypair) to modify transaction in place
Received: sign() returns a new transaction object
```

**Migration steps:**
1. Update transaction submission flow in `src/services/soroban.ts`
2. Adjust return types and error handling as needed
3. Test the full submission cycle end-to-end

### Network Changes

If `rpc.Server` method signatures or response formats change:

```
Expected: server.getAccount(accountId) to return Account object
Received: Returns a different shape or throws different errors
```

**Migration steps:**
1. Update RPC server usage in `src/services/soroban.ts`
2. Adjust response handling and error cases
3. Verify all async operations complete successfully

## Adding New SDK Features

When adopting new SDK features for Soroban or event processing:

1. Add export symbol assertions to `stellarSdkRegression.test.ts`
2. Add roundtrip or integration tests for the new feature
3. Document the feature usage in the relevant service file
4. Include test coverage in the PR

Example: Adding a new contract operation type
```typescript
describe('New contract operation type', () => {
  it('Contract.newOp() returns expected operation shape', () => {
    const operation = contract.newOp(arg1, arg2)
    expect(operation).toBeDefined()
    expect(typeof operation.toXDR).toBe('function')
  })
})
```

## Test Coverage

The regression suite achieves **100% coverage** of:
- Symbol availability (all exports exist and have correct types)
- Contract API shape (constructor, method signatures)
- TransactionBuilder shape (operation chaining, build, sign)
- XDR roundtrip integrity (encode/decode/native conversion)
- rpc.Server shape (all required methods present)
- Network constants (passphrases accessible)
- Keypair operations (generation, reconstruction)
- Integration flows (end-to-end Soroban submit, event parsing)
- Error resilience (invalid inputs gracefully rejected)

## References

- [Stellar SDK Documentation](https://developers.stellar.org/docs/tools-and-sdks/js-stellar-sdk)
- [Soroban Smart Contracts](https://developers.stellar.org/docs/smart-contracts)
- [XDR Reference](https://developers.stellar.org/docs/learn/encyclopedia/data-format/xdr)
- [src/services/soroban.ts](../src/services/soroban.ts) — Soroban submission implementation
- [src/services/eventParser.ts](../src/services/eventParser.ts) — Event parsing implementation

## Troubleshooting

### Tests timeout during rpc.Server tests
The tests make network calls to `https://example.com` which will fail. This is expected — the test validates that the method shape is correct, not that the network call succeeds.

If network timeouts occur:
```bash
npm test -- stellarSdkRegression.test.ts --testTimeout=15000
```

### Invalid contract ID errors
Ensure the test constants use `StrKey.encodeContract()` to generate valid contract IDs:
```typescript
const contractBuffer = Buffer.alloc(32, 1)
const contractId = StrKey.encodeContract(contractBuffer)
```

### Module import errors
The test uses dynamic imports (`await import('@stellar/stellar-sdk')`) to capture import errors. Ensure the SDK is installed:
```bash
npm install @stellar/stellar-sdk
```

## Maintenance

The regression suite is maintained as a **living document** of Stellar SDK API surface. When:
- New SDK exports are added to the backend
- SDK major versions bump
- New contract patterns are introduced

Update the test file accordingly to keep it comprehensive and aligned with actual usage.
