//! Fuzz harness for `AccountabilityVault::create_vault`.
//!
//! Generates random (amount, end_timestamp_offset, milestones) tuples and
//! asserts that the contract either returns `Ok(())` or a typed `Error` —
//! never an unhandled panic.
//!
//! Run locally (nightly required):
//!   cargo fuzz run create_vault -- -max_total_time=60
//!
//! The corpus is seeded with interesting boundary values in `fuzz/corpus/create_vault/`.

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, vec, Address, Env, String,
};

use accountability_vault::{AccountabilityVault, AccountabilityVaultClient, Milestone, VerifierSet};

/// Compact fuzzer-controlled input that covers all `create_vault` invariant checks.
#[derive(Debug, arbitrary::Arbitrary)]
struct FuzzInput {
    /// Overall vault amount (tested as-is, may be 0 or negative to hit InvalidAmount).
    amount: i128,
    /// Seconds added to the ledger timestamp for `end_timestamp`. Signed so the
    /// fuzzer can generate past timestamps (hits InvalidDeadline).
    end_offset: i64,
    /// Between 0 and 8 milestones (empty list hits NoMilestones).
    milestones: Vec<FuzzMilestone>,
    /// Threshold for the verifier set (0 hits InvalidThreshold, >1 tests M-of-N path).
    threshold: u32,
    /// Number of verifiers (0 hits NoVerifiers).
    num_verifiers: u8,
}

#[derive(Debug, arbitrary::Arbitrary)]
struct FuzzMilestone {
    /// Amount allocated to this milestone (0 or negative hits InvalidAmount).
    amount: i128,
    /// Seconds relative to `end_timestamp` — positive means after vault end
    /// (hits InvalidDeadline for milestone).
    due_offset: i32,
}

const LEDGER_BASE: u64 = 1_000;

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(LEDGER_BASE);

    // Register token and contract.
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_addr = sac.address();

    // Mint enough for any positive amount so token balance isn't the bottleneck.
    let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);
    let creator = Address::generate(&env);
    if input.amount > 0 {
        token_admin_client.mint(&creator, &input.amount);
    }

    let contract_id = env.register_contract(None, AccountabilityVault);
    let client = AccountabilityVaultClient::new(&env, &contract_id);

    // Build addresses.
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);

    let num_verifiers = (input.num_verifiers as usize).min(8); // cap to keep runtime bounded
    let mut verifiers = vec![&env];
    for _ in 0..num_verifiers {
        verifiers.push_back(Address::generate(&env));
    }

    let verifier_set = VerifierSet {
        verifiers,
        threshold: input.threshold,
    };

    // Compute end_timestamp, saturating at 0 to avoid u64 wraps.
    let end_timestamp = LEDGER_BASE.saturating_add_signed(input.end_offset.into());

    // Build milestone list.
    let mut milestones = vec![&env];
    for fm in input.milestones.iter().take(8) {
        // due_date relative to end_timestamp, clamp to u64 range.
        let due_date = end_timestamp.saturating_add_signed(fm.due_offset.into());
        milestones.push_back(Milestone {
            title: String::from_str(&env, "m"),
            amount: fm.amount,
            due_date,
            verified: false,
            released: false,
        });
    }

    let vault_id = String::from_str(&env, "fuzz-vault-0");

    // The only assertion: the call must not panic. Either Ok(()) or a typed Error
    // is acceptable. Panics surface as fuzzer crashes.
    let _ = client.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token_addr,
        &input.amount,
        &success,
        &failure,
        &end_timestamp,
        &milestones,
        &guardian,
    );
});
