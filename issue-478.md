# Implementation Plan: Validate `Milestone.title` Length Bound in `create_vault`

## Objective

Introduce a hard limit on `Milestone.title` length in `contracts/accountability_vault` to prevent unbounded storage growth and excessive ledger fees caused by oversized string inputs.

This ensures predictable storage costs and improves contract safety and accountability.

## Scope

### Contract Changes (`lib.rs`)

* Introduce a constant:

  ```rust
  pub const MAX_TITLE_LEN: usize = 128;
  ```
* Validate `Milestone.title` inside `create_vault` before vault creation logic executes.
* Enforce byte-length validation (not character count) using `String::len()` semantics as defined by `soroban_sdk::String`.
* Reject any title where:

  * `title.len() > MAX_TITLE_LEN`

### Error Handling

* Add a new error variant to the contract error enum:

  * `TitleTooLong`
* Alternatively (if error catalog constraints apply), evaluate reuse of `InvalidAmount` only if semantically acceptable; prefer explicit error for clarity.
* Ensure error is returned early and consistently before any storage writes occur.

## Tests

### File: `contracts/accountability_vault/src/test.rs`

Add boundary and regression tests:

* Valid case:

  * Title length exactly `MAX_TITLE_LEN` should succeed.
* Invalid case:

  * Title length `MAX_TITLE_LEN + 1` should return `TitleTooLong`.
* Edge cases:

  * Empty title (if allowed by existing logic).
  * Multi-byte UTF-8 characters to confirm byte-length enforcement.
* Ensure no partial state is written on rejection.

### Coverage Target

* ≥95% test coverage for modified contract paths.

## Documentation

### Update `contracts/README.md`

Include:

* Description of `MAX_TITLE_LEN`
* Rationale: storage cost control and ledger fee protection
* Behavior on validation failure
* Error returned (`TitleTooLong`)
* Example valid vs invalid input

## Security Considerations

* Prevents unbounded ledger bloat via oversized metadata fields.
* Ensures predictable storage fees per vault creation.
* Eliminates potential DoS vectors through large string submissions.

## Implementation Steps

1. Fork repository and create branch:

   ```bash
   git checkout -b bug/milestone-title-length-bound
   ```

2. Implement contract changes:

   * Add `MAX_TITLE_LEN`
   * Add validation in `create_vault`
   * Add error variant

3. Add tests in `test.rs`

4. Update `README.md`

5. Run full test suite:

   ```bash
   cargo test
   ```

6. Verify:

   * Boundary conditions pass
   * Over-limit titles fail correctly
   * No regression in vault creation logic

## Commit Message

```
fix: bound milestone title length in create_vault
```

## Expected Outcome

Vault creation enforces strict title size limits, preventing excessive storage usage and ensuring predictable on-chain costs while maintaining backward-compatible behavior for valid inputs.
