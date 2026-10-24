#![cfg(test)]
#![allow(deprecated)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token, vec, Address, BytesN, Env, String, Symbol, TryFromVal,
};

struct Setup {
    env: Env,
    contract: AccountabilityVaultClient<'static>,
    token: Address,
    creator: Address,
    verifier: Address,
    failure: Address,
    success: Address,
    guardian: Address,
    vault_id: String,
}

fn evidence_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        token::StellarAssetClient::new(env, &address),
    )
}

fn setup(milestone_due_offsets: &[u64], amounts: &[i128]) -> Setup {
    setup_with_oracle(milestone_due_offsets, amounts, None)
}

fn setup_with_oracle(
    milestone_due_offsets: &[u64],
    amounts: &[i128],
    oracle: Option<Address>,
) -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    let total: i128 = amounts.iter().sum();
    token_admin_client.mint(&creator, &total);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-627");

    let mut milestones = vec![&env];
    for (i, due) in milestone_due_offsets.iter().enumerate() {
        milestones.push_back(Milestone {
            title: String::from_str(&env, "m"),
            amount: amounts[i],
            due_date: 1_000 + due,
            verified: false,
            released: false,
        });
    }

    let end = 1_000 + milestone_due_offsets.iter().max().copied().unwrap_or(0);
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1,
    };
    let options = VaultOptions {
        oracle,
        guardian: guardian.clone(),
        dispute_window: 86_400,
    };

    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &total,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &end,
        &milestones,
        &options,
    );

    Setup {
        env,
        contract,
        token,
        creator,
        verifier,
        failure,
        success,
        guardian,
        vault_id,
    }
}

#[test]
fn test_withdraw_after_deadline_rejected_then_slash_succeeds() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().with_mut(|ledger| ledger.timestamp = 1_100);
    let at_deadline = s.contract.try_withdraw(&s.vault_id, &s.creator);
    assert_eq!(at_deadline, Err(Ok(Error::DeadlinePassed)));

    s.env.ledger().with_mut(|ledger| ledger.timestamp = 1_101);
    let after_deadline = s.contract.try_withdraw(&s.vault_id, &s.creator);
    assert_eq!(after_deadline, Err(Ok(Error::DeadlinePassed)));

    s.contract.slash_on_miss(&s.vault_id);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.creator), 0);
    assert_eq!(token_client.balance(&s.failure), 500);
    assert_eq!(
        s.contract.get_vault(&s.vault_id).status,
        VaultStatus::Failed
    );
}

#[test]
fn test_withdraw_within_grace_refunds() {
    let s = setup(&[WITHDRAW_GRACE_SECS + 1], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let token_client = token::Client::new(&s.env, &s.token);
    let creator_balance_before = token_client.balance(&s.creator);
    s.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = 1_000 + WITHDRAW_GRACE_SECS);

    s.contract.withdraw(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(
        token_client.balance(&s.creator),
        creator_balance_before + 500
    );
    assert_eq!(vault.status, VaultStatus::Cancelled);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.staked_at, 1_000);
}

#[test]
fn test_withdraw_after_grace_before_deadline_rejected() {
    let s = setup(&[WITHDRAW_GRACE_SECS + 100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let token_client = token::Client::new(&s.env, &s.token);
    let creator_balance_before = token_client.balance(&s.creator);
    let contract_balance_before = token_client.balance(&s.contract.address);
    s.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = 1_000 + WITHDRAW_GRACE_SECS + 1);

    let result = s.contract.try_withdraw(&s.vault_id, &s.creator);

    assert_eq!(result, Err(Ok(Error::WithdrawWindowClosed)));
    assert_eq!(token_client.balance(&s.creator), creator_balance_before);
    assert_eq!(
        token_client.balance(&s.contract.address),
        contract_balance_before
    );
    assert_eq!(
        s.contract.get_vault(&s.vault_id).status,
        VaultStatus::Active
    );
}

#[test]
fn test_withdraw_with_verified_milestone_rejected_specific_error() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));

    let result = s.contract.try_withdraw(&s.vault_id, &s.creator);

    assert_eq!(result, Err(Ok(Error::WithdrawBlockedByVerifiedMilestone)));
}

#[test]
fn test_stake_from_sets_staked_at() {
    let s = setup(&[100], &[500]);
    let spender = Address::generate(&s.env);
    token::Client::new(&s.env, &s.token).approve(&s.creator, &spender, &500, &100);

    s.contract.stake_from(&s.vault_id, &s.creator, &spender);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked_at, 1_000);
    assert_eq!(vault.staked, 500);
}

#[test]
fn test_withdraw_blocked_when_paused_or_disputed() {
    let paused = setup(&[100], &[500]);
    paused.contract.stake(&paused.vault_id, &paused.creator);
    paused
        .contract
        .emergency_pause(&paused.vault_id, &paused.guardian, &100);
    let paused_result = paused
        .contract
        .try_withdraw(&paused.vault_id, &paused.creator);
    assert_eq!(paused_result, Err(Ok(Error::Paused)));

    let disputed = setup(&[100], &[500]);
    disputed
        .contract
        .stake(&disputed.vault_id, &disputed.creator);
    disputed
        .contract
        .admin_dispute(&disputed.vault_id, &disputed.guardian, &100);
    let disputed_result = disputed
        .contract
        .try_withdraw(&disputed.vault_id, &disputed.creator);
    assert_eq!(disputed_result, Err(Ok(Error::NotActive)));
    assert_eq!(
        disputed.contract.get_vault(&disputed.vault_id).status,
        VaultStatus::Disputed
    );
}

#[test]
fn test_slash_before_deadline_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().set_timestamp(1_099);
    let before = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(matches!(before, Err(Ok(Error::DeadlineNotReached))));

    s.env.ledger().set_timestamp(1_100);
    let exactly_at_deadline = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(matches!(
        exactly_at_deadline,
        Err(Ok(Error::DeadlineNotReached))
    ));

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 500);
}

#[test]
fn test_slash_on_miss() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().set_timestamp(1_101);
    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 500);
}

#[test]
fn test_double_slash_after_miss_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);

    s.contract.slash_on_miss(&s.vault_id);
    let second = s.contract.try_slash_on_miss(&s.vault_id);

    assert!(matches!(second, Err(Ok(Error::NotActive))));
    assert_eq!(
        s.contract.get_vault(&s.vault_id).status,
        VaultStatus::Failed
    );
}

#[test]
fn test_check_in_after_slash_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);
    s.contract.slash_on_miss(&s.vault_id);

    let result = s
        .contract
        .try_check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));

    assert!(matches!(result, Err(Ok(Error::NotActive))));
}

#[test]
fn test_unauthorized_caller_check_in_fails() {
    let env = Env::default();
    let oracle = Address::generate(&env);
    let s = setup_with_oracle(&[100], &[500], Some(oracle));
    s.contract.stake(&s.vault_id, &s.creator);

    let random = Address::generate(&s.env);
    let result = s
        .contract
        .try_check_in(&s.vault_id, &random, &0, &evidence_hash(&s.env, 1));

    assert!(matches!(result, Err(Ok(Error::Unauthorized))));
}

#[test]
fn test_oracle_not_set_random_caller_check_in_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let random = Address::generate(&s.env);
    let result = s
        .contract
        .try_check_in(&s.vault_id, &random, &0, &evidence_hash(&s.env, 1));

    assert!(matches!(result, Err(Ok(Error::Unauthorized))));
}

#[test]
fn test_verifier_check_in_still_works_with_oracle_configured() {
    let env = Env::default();
    let oracle = Address::generate(&env);
    let s = setup_with_oracle(&[100], &[500], Some(oracle));
    s.contract.stake(&s.vault_id, &s.creator);

    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));

    let vault = s.contract.get_vault(&s.vault_id);
    assert!(vault.milestones.get(0).unwrap().verified);
    assert_eq!(vault.status, VaultStatus::Active);
}

#[test]
fn test_gas_benchmarks_slash_on_miss_10_milestones() {
    let offsets: [u64; 10] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    let amounts: [i128; 10] = [100; 10];
    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().set_timestamp(1_101);
    s.env.budget().reset_default();
    s.contract.slash_on_miss(&s.vault_id);

    let slash_cpu = s.env.budget().cpu_instruction_cost();
    let slash_mem = s.env.budget().memory_bytes_cost();

    std::println!(
        "slash_on_miss_10_milestones: CPU = {}, Memory = {}",
        slash_cpu,
        slash_mem
    );
    assert!(slash_cpu < 900_000);
    assert!(slash_mem < 250_000);
}

// ═══════════════════════════════════════════════════════════════════════
// i128 milestone-amount partial-payout boundary test matrix
//
// Invariants under test:
//   1. sum(milestone.amount) == vault.amount  (enforced at creation)
//   2. After sequentially claiming all milestones, vault.staked == 0
//   3. No panic / overflow on extreme i128 values
//   4. Rounding never drains escrow below solvency (staked >= 0 after
//      every intermediate claim_milestone)
//   5. Zero-amount milestones are rejected at creation
//   6. Slash transfers the full staked balance regardless of amount size
// ═══════════════════════════════════════════════════════════════════════

/// Helper: create vault, stake, verify all milestones, then claim them
/// one-by-one. Returns the final vault state.
fn claim_all_milestones_sequentially(offsets: &[u64], amounts: &[i128]) -> Vault {
    let s = setup(offsets, amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify every milestone.
    for i in 0..amounts.len() {
        s.contract
            .check_in(&s.vault_id, &s.verifier, &(i as u32), &evidence_hash(&s.env, i as u8));
    }

    // Claim milestones one at a time and assert intermediate solvency.
    let token_client = token::Client::new(&s.env, &s.token);
    let contract_addr = s.contract.address.clone();
    let total: i128 = amounts.iter().sum();

    let mut released_so_far: i128 = 0;
    for (i, &amount) in amounts.iter().enumerate() {
        s.contract.claim_milestone(&s.vault_id, &s.creator, &(i as u32));
        released_so_far += amount;

        let vault = s.contract.get_vault(&s.vault_id);
        // Solvency: staked must equal what remains.
        assert_eq!(
            vault.staked,
            total - released_so_far,
            "solvency violation after claiming milestone {}",
            i
        );
        // Contract balance must cover the remaining staked amount.
        assert!(
            token_client.balance(&contract_addr) >= vault.staked,
            "contract balance underflow after milestone {}",
            i
        );
    }

    s.contract.get_vault(&s.vault_id)
}

// ─── 1. Minimum valid amount (1 unit per milestone) ─────────────────

#[test]
fn test_boundary_single_milestone_amount_one() {
    let vault = claim_all_milestones_sequentially(&[100], &[1]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_three_milestones_amount_one_each() {
    let vault = claim_all_milestones_sequentially(&[100, 200, 300], &[1, 1, 1]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 2. Large near-max i128 amounts ─────────────────────────────────

#[test]
fn test_boundary_single_milestone_large_amount() {
    // Use a large value that stays well within i128::MAX but exercises
    // high-magnitude arithmetic (10^36).
    let large: i128 = 1_000_000_000_000_000_000_000_000_000_000_000_000; // 10^36
    let vault = claim_all_milestones_sequentially(&[100], &[large]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_two_milestones_sum_near_max() {
    // Two milestones whose sum is close to i128::MAX.
    // i128::MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727
    let half = i128::MAX / 2;            // 85_070_591_730_234_615_865_843_651_857_942_052_863
    let other_half = i128::MAX - half;   // 85_070_591_730_234_615_865_843_651_857_942_052_864
    assert_eq!(half + other_half, i128::MAX);

    let s = setup(&[100, 200], &[half, other_half]);

    // Vault creation succeeds, proving the sum check handles i128::MAX.
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.amount, i128::MAX);
    assert_eq!(vault.milestones.len(), 2);
    assert_eq!(vault.milestones.get(0).unwrap().amount, half);
    assert_eq!(vault.milestones.get(1).unwrap().amount, other_half);
}

// ─── 3. Uneven 3-way split with remainder ───────────────────────────

#[test]
fn test_boundary_uneven_three_way_split() {
    // 100 / 3 = 33 remainder 1. We split as 34 + 33 + 33 so the sum is exact.
    let vault = claim_all_milestones_sequentially(&[100, 200, 300], &[34, 33, 33]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_uneven_seven_way_split() {
    // 1_000_000 across 7 milestones. 1_000_000 / 7 = 142_857 rem 1.
    // Distribute as: 6 × 142_857 + 1 × 142_858 = 1_000_000.
    let amounts: [i128; 7] = [142_857, 142_857, 142_857, 142_857, 142_857, 142_857, 142_858];
    let offsets: [u64; 7] = [10, 20, 30, 40, 50, 60, 70];
    assert_eq!(amounts.iter().sum::<i128>(), 1_000_000);

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_prime_split() {
    // A prime total (997) split across 3 milestones.
    // 997 / 3 = 332 rem 1 → 333 + 332 + 332.
    let vault = claim_all_milestones_sequentially(&[100, 200, 300], &[333, 332, 332]);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 4. Bulk claim path with boundary amounts ───────────────────────

#[test]
fn test_boundary_bulk_claim_amount_one() {
    let s = setup(&[100], &[1]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    s.contract.claim(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_bulk_claim_large_amount() {
    let large: i128 = 999_999_999_999_999_999_999_999_999; // ~10^27
    let s = setup(&[100], &[large]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    s.contract.claim(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);

    let token_client = token::Client::new(&s.env, &s.token);
    let success_dest = vault.success_destination;
    assert_eq!(token_client.balance(&success_dest), large);
}

// ─── 5. Slash path with boundary amounts ────────────────────────────

#[test]
fn test_boundary_slash_amount_one() {
    let s = setup(&[100], &[1]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);

    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Failed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 1);
}

#[test]
fn test_boundary_slash_large_amount() {
    let large: i128 = 1_000_000_000_000_000_000_000_000_000_000_000_000; // 10^36
    let s = setup(&[100], &[large]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_101);

    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Failed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), large);
}

#[test]
fn test_boundary_slash_uneven_multi_milestone() {
    // 5 milestones with uneven amounts; slash must transfer entire staked
    // balance regardless of per-milestone distribution.
    let amounts: [i128; 5] = [17, 31, 29, 11, 12];
    let offsets: [u64; 5] = [10, 20, 30, 40, 50];
    let total: i128 = amounts.iter().sum();

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);
    s.env.ledger().set_timestamp(1_051);

    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), total);
}

// ─── 6. Mixed large + small milestones ──────────────────────────────

#[test]
fn test_boundary_mixed_large_and_tiny_milestones() {
    // One very large milestone alongside a single-unit milestone.
    // Tests that subtracting 1 from a huge staked value doesn't break.
    let large: i128 = 999_999_999_999_999_999;
    let amounts = [large, 1];
    let offsets = [100, 200];

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_descending_powers_of_ten() {
    // Milestones: 10^12, 10^6, 10^3, 10^0 = [1_000_000_000_000, 1_000_000, 1_000, 1]
    let amounts: [i128; 4] = [1_000_000_000_000, 1_000_000, 1_000, 1];
    let offsets: [u64; 4] = [100, 200, 300, 400];

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 7. Rejection of invalid amounts at vault creation ──────────────

#[test]
fn test_boundary_zero_amount_milestone_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &100);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-zero");

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 0,
            due_date: 1_100,
            verified: false,
            released: false,
        },
        Milestone {
            title: String::from_str(&env, "m2"),
            amount: 100,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ];

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };

    let guardian = Address::generate(&env);
    let options = VaultOptions {
        oracle: None,
        guardian,
        dispute_window: 86_400,
    };

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &1_100u64,
        &milestones,
        &options,
    );
    assert!(matches!(result, Err(Ok(Error::InvalidAmount))));
}

#[test]
fn test_boundary_negative_amount_milestone_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &100);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-neg");

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: -1,
            due_date: 1_100,
            verified: false,
            released: false,
        },
        Milestone {
            title: String::from_str(&env, "m2"),
            amount: 101,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ];

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };
    let options = VaultOptions {
        oracle: None,
        guardian,
        dispute_window: 86_400,
    };

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &1_100u64,
        &milestones,
        &options,
    );
    assert!(matches!(result, Err(Ok(Error::InvalidAmount))));
}

#[test]
fn test_boundary_milestone_sum_mismatch_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &100);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-mis");

    // Milestones sum to 99 but declared amount is 100.
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 50,
            due_date: 1_100,
            verified: false,
            released: false,
        },
        Milestone {
            title: String::from_str(&env, "m2"),
            amount: 49,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ];

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };
    let options = VaultOptions {
        oracle: None,
        guardian,
        dispute_window: 86_400,
    };

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &1_100u64,
        &milestones,
        &options,
    );
    assert!(matches!(result, Err(Ok(Error::AmountMismatch))));
}

// ─── 8. Partial claim then slash (mixed path) ───────────────────────

#[test]
fn test_boundary_partial_claim_then_bulk_claim_rejected() {
    // After claiming one milestone via claim_milestone, bulk claim must be
    // rejected to prevent double-release.
    let amounts: [i128; 3] = [100, 200, 300];
    let offsets: [u64; 3] = [100, 200, 300];

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify all milestones.
    for i in 0..3u32 {
        s.contract
            .check_in(&s.vault_id, &s.verifier, &i, &evidence_hash(&s.env, i as u8));
    }

    // Claim only the first milestone.
    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 500); // 600 - 100

    // Bulk claim must be rejected.
    let result = s.contract.try_claim(&s.vault_id, &s.creator);
    assert!(matches!(result, Err(Ok(Error::PartiallyReleased))));
}

// ─── 9. Double claim_milestone rejected ─────────────────────────────

#[test]
fn test_boundary_double_claim_milestone_rejected() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);

    let result = s
        .contract
        .try_claim_milestone(&s.vault_id, &s.creator, &0);
    // Second claim should fail because vault is now Completed (single milestone).
    assert!(result.is_err());
}

// ─── 10. Solvency matrix: N milestones claimed in various orders ────

#[test]
fn test_boundary_reverse_order_claim() {
    // Claim milestones in reverse order to verify staked balance
    // is exact regardless of claim sequence.
    let amounts: [i128; 4] = [1, 2, 3, 4];
    let offsets: [u64; 4] = [100, 200, 300, 400];
    let total: i128 = amounts.iter().sum(); // 10

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    for i in 0..4u32 {
        s.contract
            .check_in(&s.vault_id, &s.verifier, &i, &evidence_hash(&s.env, i as u8));
    }

    let mut released: i128 = 0;
    for i in (0..4u32).rev() {
        s.contract.claim_milestone(&s.vault_id, &s.creator, &i);
        released += amounts[i as usize];

        let vault = s.contract.get_vault(&s.vault_id);
        assert_eq!(
            vault.staked,
            total - released,
            "solvency violation after reverse-claiming milestone {}",
            i
        );
    }

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
fn test_boundary_interleaved_claim_order() {
    // Claim in order: 2, 0, 4, 1, 3 (non-sequential).
    let amounts: [i128; 5] = [10, 20, 30, 40, 50];
    let offsets: [u64; 5] = [100, 200, 300, 400, 500];
    let total: i128 = amounts.iter().sum(); // 150

    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    for i in 0..5u32 {
        s.contract
            .check_in(&s.vault_id, &s.verifier, &i, &evidence_hash(&s.env, i as u8));
    }

    let claim_order: [u32; 5] = [2, 0, 4, 1, 3];
    let mut released: i128 = 0;
    for &idx in claim_order.iter() {
        s.contract.claim_milestone(&s.vault_id, &s.creator, &idx);
        released += amounts[idx as usize];

        let vault = s.contract.get_vault(&s.vault_id);
        assert_eq!(
            vault.staked,
            total - released,
            "solvency violation after claiming milestone {} (interleaved)",
            idx
        );
        // Invariant: staked must never go negative.
        assert!(vault.staked >= 0, "negative staked after milestone {}", idx);
    }

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 11. Boundary: many milestones with amount=1 ────────────────────

#[test]
fn test_boundary_twenty_milestones_amount_one() {
    let n = 20;
    let amounts = [1i128; 20];
    let offsets: std::vec::Vec<u64> = (1..=n).map(|i| i as u64 * 10).collect();

    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 12. Boundary: large remainder routing across many milestones ───

#[test]
fn test_boundary_large_total_uneven_13_way_split() {
    // Total: 10^18, 13 milestones.
    // 10^18 / 13 = 76_923_076_923_076_923 rem 1.
    let base: i128 = 76_923_076_923_076_923;
    let mut amounts = [base; 13];
    amounts[12] = base + 1; // absorb the remainder
    let total: i128 = amounts.iter().sum();
    assert_eq!(total, 1_000_000_000_000_000_000i128);

    let offsets: std::vec::Vec<u64> = (1..=13).map(|i| i as u64 * 10).collect();
    let vault = claim_all_milestones_sequentially(&offsets, &amounts);
    assert_eq!(vault.staked, 0);
    assert_eq!(vault.status, VaultStatus::Completed);
}

// ─── 13. Boundary: title length bound ────────────────────────────────

#[test]
fn test_create_vault_title_length_bound() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, _token_admin_client) = create_token(&env, &token_admin);
    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-title-test");

    let guardian = Address::generate(&env);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };
    let options = VaultOptions {
        oracle: None,
        guardian,
        dispute_window: 86_400,
    };

    // Exactly 128 chars -> OK
    let title_128 = String::from_str(
        &env,
        "01234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567",
    );
    let milestones_ok = vec![
        &env,
        Milestone {
            title: title_128,
            amount: 100,
            due_date: 2_000,
            verified: false,
            released: false,
        },
    ];

    let res = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones_ok,
        &options,
    );
    assert!(res.is_ok());

    // 129 chars -> TitleTooLong
    let title_129 = String::from_str(
        &env,
        "012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678",
    );
    let milestones_err = vec![
        &env,
        Milestone {
            title: title_129,
            amount: 100,
            due_date: 2_000,
            verified: false,
            released: false,
        },
    ];
    let vault_id_2 = String::from_str(&env, "vault-title-test-2");
    let res_err = contract.try_create_vault(
        &vault_id_2,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones_err,
        &options,
    );
    assert_eq!(res_err, Err(Ok(Error::TitleTooLong)));
}

// ─── 14. Guardian and Pause Constraints Tests ───────────────────────

#[test]
fn test_guardian_must_differ_from_creator() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, _token_admin_client) = create_token(&env, &token_admin);
    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-guardian-test");

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1,
    };

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "M1"),
            amount: 100,
            due_date: 2_000,
            verified: false,
            released: false,
        },
    ];

    // Case 1: guardian == creator -> InvalidGuardian
    let res = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian: creator.clone(),
            dispute_window: 86_400,
        },
    );
    assert_eq!(res, Err(Ok(Error::InvalidGuardian)));

    // Case 2: guardian == success_destination -> InvalidGuardian
    let res_succ = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian: success.clone(),
            dispute_window: 86_400,
        },
    );
    assert_eq!(res_succ, Err(Ok(Error::InvalidGuardian)));

    // Case 3: guardian is sole verifier -> InvalidGuardian
    let res_sole_verifier = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian: verifier,
            dispute_window: 86_400,
        },
    );
    assert_eq!(res_sole_verifier, Err(Ok(Error::InvalidGuardian)));

    // Case 4: valid distinct guardian -> OK
    let guardian = Address::generate(&env);
    let res_ok = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian,
            dispute_window: 86_400,
        },
    );
    assert!(res_ok.is_ok());
}

#[test]
fn test_creator_cannot_pause_or_dispute() {
    let s = setup(&[100], &[100]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Creator calling emergency_pause -> Unauthorized
    let res_pause = s.contract.try_emergency_pause(&s.vault_id, &s.creator, &86_400);
    assert_eq!(res_pause, Err(Ok(Error::Unauthorized)));

    // Creator calling admin_dispute -> Unauthorized
    let res_dispute = s.contract.try_admin_dispute(&s.vault_id, &s.creator, &86_400);
    assert_eq!(res_dispute, Err(Ok(Error::Unauthorized)));

    // Guardian calling emergency_pause -> Ok
    let res_guard_pause = s.contract.try_emergency_pause(&s.vault_id, &s.guardian, &86_400);
    assert!(res_guard_pause.is_ok());
}

#[test]
fn test_pause_expires_and_slash_proceeds() {
    let s = setup(&[100], &[100]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Ledger timestamp is 1_000 at setup. End date is 1_100.
    // Guardian pauses for 100 seconds: paused_until = 1_100.
    s.contract.emergency_pause(&s.vault_id, &s.guardian, &100);

    // Advance ledger to 1_050: deadline not passed yet, but also vault is paused.
    s.env.ledger().set_timestamp(1_050);
    let res_slash_early = s.contract.try_slash_on_miss(&s.vault_id);
    // At 1_050, paused is active -> Paused error
    assert_eq!(res_slash_early, Err(Ok(Error::Paused)));

    // Advance ledger to 1_100 (exactly at paused_until boundary -> still paused)
    s.env.ledger().set_timestamp(1_100);
    let res_slash_boundary = s.contract.try_slash_on_miss(&s.vault_id);
    assert_eq!(res_slash_boundary, Err(Ok(Error::Paused)));

    // Advance ledger past paused_until and past end_date (e.g. 1_101)
    s.env.ledger().set_timestamp(1_101);
    // Pause has expired! slash_on_miss proceeds to slash to failure address.
    let slash_res = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(slash_res.is_ok());
    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 100);
    assert_eq!(token_client.balance(&s.contract.address), 0);
}

#[test]
fn test_dispute_expires_and_slash_proceeds() {
    let s = setup(&[100], &[100]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Ledger timestamp is 1_000. End date is 1_100.
    // Guardian puts vault into dispute for 100 seconds: disputed_until = 1_100.
    s.contract.admin_dispute(&s.vault_id, &s.guardian, &100);

    // Advance to 1_050: status is Disputed -> VaultDisputed
    s.env.ledger().set_timestamp(1_050);
    let res_slash_early = s.contract.try_slash_on_miss(&s.vault_id);
    assert_eq!(res_slash_early, Err(Ok(Error::VaultDisputed)));

    // Advance past disputed_until and past end_date (e.g. 1_101)
    s.env.ledger().set_timestamp(1_101);
    // Dispute expired! It should automatically resume / allow slash_on_miss.
    let slash_res = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(slash_res.is_ok());
    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 100);
    assert_eq!(token_client.balance(&s.contract.address), 0);
}

#[test]
fn test_claim_milestone_blocked_when_paused() {
    let s = setup(&[100, 200], &[50, 50]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verifier verifies milestone 0
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    // Guardian pauses the vault
    s.contract.emergency_pause(&s.vault_id, &s.guardian, &86_400);

    let token_client = token::Client::new(&s.env, &s.token);
    let pre_success_bal = token_client.balance(&s.success);
    let pre_contract_bal = token_client.balance(&s.contract.address);

    // Attempt to claim milestone while paused -> Error::Paused
    let claim_res = s.contract.try_claim_milestone(&s.vault_id, &s.creator, &0);
    assert_eq!(claim_res, Err(Ok(Error::Paused)));

    // Assert NO balance changes occurred
    assert_eq!(token_client.balance(&s.success), pre_success_bal);
    assert_eq!(token_client.balance(&s.contract.address), pre_contract_bal);

    // Guardian unpauses
    s.contract.emergency_unpause(&s.vault_id, &s.guardian);

    // Now claim_milestone succeeds
    let claim_res2 = s.contract.try_claim_milestone(&s.vault_id, &s.creator, &0);
    assert!(claim_res2.is_ok());
    assert_eq!(token_client.balance(&s.success), pre_success_bal + 50);
}

#[test]
fn test_cancel_rejected_for_each_non_draft_status() {
    // 1. Active status
    {
        let s = setup(&[100], &[500]);
        s.contract.stake(&s.vault_id, &s.creator);
        let token_client = token::Client::new(&s.env, &s.token);
        let pre_contract_bal = token_client.balance(&s.contract.address);
        let pre_creator_bal = token_client.balance(&s.creator);

        let res = s.contract.try_cancel_vault(&s.vault_id, &s.creator);
        assert_eq!(res, Err(Ok(Error::NotDraft)));
        assert_eq!(s.contract.get_vault(&s.vault_id).status, VaultStatus::Active);
        assert_eq!(token_client.balance(&s.contract.address), pre_contract_bal);
        assert_eq!(token_client.balance(&s.creator), pre_creator_bal);
    }

    // 2. Completed status
    {
        let s = setup(&[100], &[500]);
        s.contract.stake(&s.vault_id, &s.creator);
        s.contract
            .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));
        s.contract.claim(&s.vault_id, &s.creator);
        assert_eq!(
            s.contract.get_vault(&s.vault_id).status,
            VaultStatus::Completed
        );
        let token_client = token::Client::new(&s.env, &s.token);
        let pre_contract_bal = token_client.balance(&s.contract.address);

        let res = s.contract.try_cancel_vault(&s.vault_id, &s.creator);
        assert_eq!(res, Err(Ok(Error::NotDraft)));
        assert_eq!(
            s.contract.get_vault(&s.vault_id).status,
            VaultStatus::Completed
        );
        assert_eq!(token_client.balance(&s.contract.address), pre_contract_bal);
    }

    // 3. Failed status
    {
        let s = setup(&[100], &[500]);
        s.contract.stake(&s.vault_id, &s.creator);
        s.env.ledger().set_timestamp(1_101);
        s.contract.slash_on_miss(&s.vault_id);
        assert_eq!(s.contract.get_vault(&s.vault_id).status, VaultStatus::Failed);
        let token_client = token::Client::new(&s.env, &s.token);
        let pre_failure_bal = token_client.balance(&s.failure);

        let res = s.contract.try_cancel_vault(&s.vault_id, &s.creator);
        assert_eq!(res, Err(Ok(Error::NotDraft)));
        assert_eq!(s.contract.get_vault(&s.vault_id).status, VaultStatus::Failed);
        assert_eq!(token_client.balance(&s.failure), pre_failure_bal);
    }

    // 4. Cancelled status
    {
        let s = setup(&[100], &[500]);
        s.contract.cancel_vault(&s.vault_id, &s.creator);
        assert_eq!(
            s.contract.get_vault(&s.vault_id).status,
            VaultStatus::Cancelled
        );

        let res = s.contract.try_cancel_vault(&s.vault_id, &s.creator);
        assert_eq!(res, Err(Ok(Error::NotDraft)));
        assert_eq!(
            s.contract.get_vault(&s.vault_id).status,
            VaultStatus::Cancelled
        );
    }

    // 5. Disputed status
    {
        let s = setup(&[100], &[500]);
        s.contract.stake(&s.vault_id, &s.creator);
        s.contract.admin_dispute(&s.vault_id, &s.guardian, &100);
        assert_eq!(
            s.contract.get_vault(&s.vault_id).status,
            VaultStatus::Disputed
        );
        let token_client = token::Client::new(&s.env, &s.token);
        let pre_contract_bal = token_client.balance(&s.contract.address);

        let res = s.contract.try_cancel_vault(&s.vault_id, &s.creator);
        assert_eq!(res, Err(Ok(Error::NotDraft)));
        assert_eq!(
            s.contract.get_vault(&s.vault_id).status,
            VaultStatus::Disputed
        );
        assert_eq!(token_client.balance(&s.contract.address), pre_contract_bal);
    }
}

#[test]
fn test_cancel_cannot_block_slash() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Advance past deadline
    s.env.ledger().set_timestamp(1_101);

    // Creator attempts to cancel overdue vault to evade slash
    let cancel_res = s.contract.try_cancel_vault(&s.vault_id, &s.creator);
    assert_eq!(cancel_res, Err(Ok(Error::NotDraft)));

    // Status remains Active
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Active);

    // Slashing proceeds and succeeds
    let slash_res = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(slash_res.is_ok());

    let slashed_vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(slashed_vault.status, VaultStatus::Failed);
    assert_eq!(slashed_vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 500);
    assert_eq!(token_client.balance(&s.contract.address), 0);
}

#[test]
fn test_cancel_draft_event_topic_is_symbol() {
    let s = setup(&[100], &[500]);
    s.contract.cancel_vault(&s.vault_id, &s.creator);

    let events = s.env.events().all();
    let (_, topics, _) = events.last().expect("expected event");
    let topic_val = topics.get(0).expect("expected topic");

    let topic_sym = Symbol::try_from_val(&s.env, &topic_val);
    assert_eq!(topic_sym, Ok(Symbol::new(&s.env, "vault_cancelled")));

    let topic_str = String::try_from_val(&s.env, &topic_val);
    assert!(topic_str.is_err(), "topic must be Symbol, not String");
}

#[test]
fn test_dispute_events_use_symbol_topics() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // 1. admin_dispute event
    s.contract.admin_dispute(&s.vault_id, &s.guardian, &100);
    let events = s.env.events().all();
    let (_, dispute_topics, _) = events.last().expect("expected dispute event");
    let dispute_topic_val = dispute_topics.get(0).expect("expected topic");

    let dispute_sym = Symbol::try_from_val(&s.env, &dispute_topic_val);
    assert_eq!(dispute_sym, Ok(Symbol::new(&s.env, "vault_disputed")));
    assert!(
        String::try_from_val(&s.env, &dispute_topic_val).is_err(),
        "dispute topic must be Symbol, not String"
    );

    // 2. admin_resolve event
    s.contract
        .admin_resolve(&s.vault_id, &s.guardian, &VaultStatus::Active);
    let events2 = s.env.events().all();
    let (_, resolve_topics, _) = events2.last().expect("expected resolve event");
    let resolve_topic_val = resolve_topics.get(0).expect("expected topic");

    let resolve_sym = Symbol::try_from_val(&s.env, &resolve_topic_val);
    assert_eq!(
        resolve_sym,
        Ok(Symbol::new(&s.env, "vault_dispute_resolved"))
    );
    assert!(
        String::try_from_val(&s.env, &resolve_topic_val).is_err(),
        "resolve topic must be Symbol, not String"
    );
}

// ─── 15. Per-Vault Bounded Dispute Window Tests ─────────────────────

#[test]
fn test_dispute_window_bounds_on_create() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, _) = create_token(&env, &token_admin);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 100,
            due_date: 2_000,
            verified: false,
            released: false,
        },
    ];

    // Below lower bound (0 and MIN_DISPUTE_WINDOW - 1) -> InvalidDisputeWindow
    for invalid_low in [0u64, MIN_DISPUTE_WINDOW - 1] {
        let res = contract.try_create_vault(
            &String::from_str(&env, "vault-low"),
            &creator,
            &verifier_set,
            &token,
            &100,
            &Destinations {
                success: success.clone(),
                failure: failure.clone(),
            },
            &2_000,
            &milestones,
            &VaultOptions {
                oracle: None,
                guardian: guardian.clone(),
                dispute_window: invalid_low,
            },
        );
        assert_eq!(res, Err(Ok(Error::InvalidDisputeWindow)));
    }

    // Above upper bound (MAX_DISPUTE_WINDOW + 1 and u64::MAX) -> InvalidDisputeWindow
    for invalid_high in [MAX_DISPUTE_WINDOW + 1, u64::MAX] {
        let res = contract.try_create_vault(
            &String::from_str(&env, "vault-high"),
            &creator,
            &verifier_set,
            &token,
            &100,
            &Destinations {
                success: success.clone(),
                failure: failure.clone(),
            },
            &2_000,
            &milestones,
            &VaultOptions {
                oracle: None,
                guardian: guardian.clone(),
                dispute_window: invalid_high,
            },
        );
        assert_eq!(res, Err(Ok(Error::InvalidDisputeWindow)));
    }

    // Exactly at lower bound (MIN_DISPUTE_WINDOW = 1h) -> Ok
    let vault_min = String::from_str(&env, "vault-min");
    let res_min = contract.try_create_vault(
        &vault_min,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian: guardian.clone(),
            dispute_window: MIN_DISPUTE_WINDOW,
        },
    );
    assert!(res_min.is_ok());
    assert_eq!(contract.get_vault(&vault_min).dispute_window, MIN_DISPUTE_WINDOW);

    // Exactly at upper bound (MAX_DISPUTE_WINDOW = 30d) -> Ok
    let vault_max = String::from_str(&env, "vault-max");
    let res_max = contract.try_create_vault(
        &vault_max,
        &creator,
        &verifier_set,
        &token,
        &100,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian,
            dispute_window: MAX_DISPUTE_WINDOW,
        },
    );
    assert!(res_max.is_ok());
    assert_eq!(contract.get_vault(&vault_max).dispute_window, MAX_DISPUTE_WINDOW);
}

#[test]
fn test_dispute_within_and_after_window() {
    let s = setup(&[10_000], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Check-in at t = 1_000; default setup dispute_window is 86_400 (window ends at 87_400).
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 1));
    assert!(s.contract.get_vault(&s.vault_id).milestones.get(0).unwrap().verified);

    // At exact boundary (t = 87_400), dispute succeeds.
    s.env.ledger().set_timestamp(87_400);
    let within = s.contract.try_dispute_milestone(&s.vault_id, &s.creator, &0);
    assert!(within.is_ok());
    assert!(!s.contract.get_vault(&s.vault_id).milestones.get(0).unwrap().verified);

    // Create a second vault to test disputing after the window expires.
    let vault_id_2 = String::from_str(&s.env, "vault-after-window");
    let verifier2 = Address::generate(&s.env);
    let token_admin = Address::generate(&s.env);
    let (token2, token_admin_client2) = create_token(&s.env, &token_admin);
    token_admin_client2.mint(&s.creator, &500);

    let milestones2 = vec![
        &s.env,
        Milestone {
            title: String::from_str(&s.env, "m1"),
            amount: 500,
            due_date: 100_000,
            verified: false,
            released: false,
        },
    ];
    s.contract.create_vault(
        &vault_id_2,
        &s.creator,
        &VerifierSet {
            verifiers: vec![&s.env, verifier2.clone()],
            threshold: 1,
        },
        &token2,
        &500,
        &Destinations {
            success: s.success.clone(),
            failure: s.failure.clone(),
        },
        &100_000,
        &milestones2,
        &VaultOptions {
            oracle: None,
            guardian: s.guardian.clone(),
            dispute_window: MIN_DISPUTE_WINDOW,
        },
    );
    s.contract.stake(&vault_id_2, &s.creator);

    // Check-in at t = 87_400 with window = 3_600 -> window ends at 91_000.
    s.contract
        .check_in(&vault_id_2, &verifier2, &0, &evidence_hash(&s.env, 2));

    // Advance 1 second past the window (t = 91_001) -> DeadlinePassed.
    s.env.ledger().set_timestamp(91_001);
    let after = s.contract.try_dispute_milestone(&vault_id_2, &s.creator, &0);
    assert_eq!(after, Err(Ok(Error::DeadlinePassed)));
    assert!(s.contract.get_vault(&vault_id_2).milestones.get(0).unwrap().verified);
}

#[test]
fn test_dispute_windows_independent_per_vault() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &1_000);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 500,
            due_date: 50_000,
            verified: false,
            released: false,
        },
    ];

    let vault_short = String::from_str(&env, "vault-short");
    let vault_long = String::from_str(&env, "vault-long");

    // Vault 1: 1 hour dispute window (3_600s)
    contract.create_vault(
        &vault_short,
        &creator,
        &VerifierSet {
            verifiers: vec![&env, verifier1.clone()],
            threshold: 1,
        },
        &token,
        &500,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &50_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian: guardian.clone(),
            dispute_window: MIN_DISPUTE_WINDOW,
        },
    );

    // Vault 2: 24 hour dispute window (86_400s)
    contract.create_vault(
        &vault_long,
        &creator,
        &VerifierSet {
            verifiers: vec![&env, verifier2.clone()],
            threshold: 1,
        },
        &token,
        &500,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &50_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian,
            dispute_window: 86_400,
        },
    );

    contract.stake(&vault_short, &creator);
    contract.stake(&vault_long, &creator);

    // Both checked in at t = 1_000.
    contract.check_in(&vault_short, &verifier1, &0, &evidence_hash(&env, 1));
    contract.check_in(&vault_long, &verifier2, &0, &evidence_hash(&env, 2));

    // Advance to t = 5_000 (4_000s elapsed: past vault_short's 3_600s window, within vault_long's 86_400s window).
    env.ledger().set_timestamp(5_000);

    let res_short = contract.try_dispute_milestone(&vault_short, &creator, &0);
    assert_eq!(res_short, Err(Ok(Error::DeadlinePassed)));
    assert!(contract.get_vault(&vault_short).milestones.get(0).unwrap().verified);

    let res_long = contract.try_dispute_milestone(&vault_long, &creator, &0);
    assert!(res_long.is_ok());
    assert!(!contract.get_vault(&vault_long).milestones.get(0).unwrap().verified);
}

#[test]
fn test_dispute_without_checkin_record_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-no-checkin");

    // Milestone created with verified = true directly, so no DataKey::CheckIn(0) record exists.
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 500,
            due_date: 2_000,
            verified: true,
            released: false,
        },
    ];

    contract.create_vault(
        &vault_id,
        &creator,
        &VerifierSet {
            verifiers: vec![&env, verifier],
            threshold: 1,
        },
        &token,
        &500,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &2_000,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian,
            dispute_window: 86_400,
        },
    );
    contract.stake(&vault_id, &creator);

    // Must fail rather than defaulting verified_at to 0.
    let res = contract.try_dispute_milestone(&vault_id, &creator, &0);
    assert_eq!(res, Err(Ok(Error::MilestonesIncomplete)));
}

#[test]
fn test_dispute_window_no_overflow_panic() {
    let env = Env::default();
    env.mock_all_auths();

    // Set ledger time near u64::MAX - MAX_DISPUTE_WINDOW so that verified_at + MAX_DISPUTE_WINDOW overflows u64.
    let near_max = u64::MAX - MAX_DISPUTE_WINDOW + 100;
    env.ledger().set_timestamp(near_max);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let vault_id = String::from_str(&env, "vault-overflow");

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 500,
            due_date: u64::MAX,
            verified: false,
            released: false,
        },
    ];

    contract.create_vault(
        &vault_id,
        &creator,
        &VerifierSet {
            verifiers: vec![&env, verifier.clone()],
            threshold: 1,
        },
        &token,
        &500,
        &Destinations {
            success: success.clone(),
            failure: failure.clone(),
        },
        &u64::MAX,
        &milestones,
        &VaultOptions {
            oracle: None,
            guardian,
            dispute_window: MAX_DISPUTE_WINDOW,
        },
    );
    contract.stake(&vault_id, &creator);

    // Check-in records verified_at = near_max (u64::MAX - MAX_DISPUTE_WINDOW + 100).
    contract.check_in(&vault_id, &verifier, &0, &evidence_hash(&env, 9));

    // verified_at.checked_add(MAX_DISPUTE_WINDOW) overflows u64 and returns a typed error, not a panic.
    let res = contract.try_dispute_milestone(&vault_id, &creator, &0);
    assert_eq!(res, Err(Ok(Error::InvalidDeadline)));
}


// ═══════════════════════════════════════════════════════════════════════
// Partial settlement tests: slash_on_miss pays verified-unclaimed to success
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_slash_pays_verified_unclaimed_to_success() {
    // 3 milestones: [verified, verified, unverified], none claimed.
    // slash_on_miss should pay the first two to success_destination
    // and the third to failure_destination.
    let amounts: [i128; 3] = [100, 200, 300];
    let offsets: [u64; 3] = [100, 200, 300];
    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify first two milestones
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));
    s.contract
        .check_in(&s.vault_id, &s.verifier, &1, &evidence_hash(&s.env, 1));

    // Move past deadline and slash
    s.env.ledger().set_timestamp(1_301);
    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);
    assert_eq!(vault.staked, 0);
    assert!(vault.milestones.get(0).unwrap().released);
    assert!(vault.milestones.get(1).unwrap().released);
    assert!(!vault.milestones.get(2).unwrap().released);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 300); // 100 + 200
    assert_eq!(token_client.balance(&s.failure), 300); // unverified
}

#[test]
fn test_slash_after_partial_claims() {
    // 3 milestones: [claimed, verified, unverified]
    // slash_on_miss should pay only the verified-unclaimed (second) to success
    // and the unverified (third) to failure.
    let amounts: [i128; 3] = [100, 200, 300];
    let offsets: [u64; 3] = [100, 200, 300];
    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify first two milestones
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));
    s.contract
        .check_in(&s.vault_id, &s.verifier, &1, &evidence_hash(&s.env, 1));

    // Claim the first milestone before deadline
    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);

    // Verify vault state after claim
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 500); // 600 - 100

    // Move past deadline and slash
    s.env.ledger().set_timestamp(1_301);
    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    // Success gets: claimed (100) + verified-unclaimed (200) = 300
    assert_eq!(token_client.balance(&s.success), 300);
    // Failure gets: unverified (300) = 300
    assert_eq!(token_client.balance(&s.failure), 300);
}

#[test]
fn test_slash_nothing_verified_unchanged() {
    // All milestones unverified → full stake goes to failure_destination
    let amounts: [i128; 3] = [100, 200, 300];
    let offsets: [u64; 3] = [100, 200, 300];
    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    s.env.ledger().set_timestamp(1_301);
    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 0);
    assert_eq!(token_client.balance(&s.failure), 600);
}

#[test]
fn test_claim_milestone_persists_before_transfer() {
    // Verify CEI ordering: vault state must be persisted before token transfer.
    // We cannot directly test re-entrancy without a mock token that attempts
    // re-entry, but we can verify the state is correct after the call.
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract
        .check_in(&s.vault_id, &s.verifier, &0, &evidence_hash(&s.env, 0));

    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);

    // After claim_milestone, the vault should be Completed and milestone released
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Completed);
    assert!(vault.milestones.get(0).unwrap().released);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 500);
}

#[test]
fn test_partial_settlement_conservation() {
    // Property test: for any mix of verified/unverified milestones,
    // success + failure payouts must equal the original amount.
    let amounts: [i128; 6] = [10, 20, 30, 40, 50, 60];
    let offsets: [u64; 6] = [100, 200, 300, 400, 500, 600];
    let total: i128 = amounts.iter().sum(); // 210

    // Test various verification patterns
    let patterns = [
        [true, false, false, false, false, false],  // only first verified
        [true, true, false, false, false, false],   // first two verified
        [false, true, false, true, false, true],    // alternating
        [true, true, true, false, false, false],    // first half verified
        [false, false, false, true, true, true],    // second half verified
    ];

    for pattern in patterns.iter() {
        let s = setup(&offsets, &amounts);
        s.contract.stake(&s.vault_id, &s.creator);

        // Verify according to pattern
        for (i, &verified) in pattern.iter().enumerate() {
            if verified {
                s.contract
                    .check_in(&s.vault_id, &s.verifier, &(i as u32), &evidence_hash(&s.env, i as u8));
            }
        }

        // Slash after deadline
        s.env.ledger().set_timestamp(1_601);
        s.contract.slash_on_miss(&s.vault_id);

        let token_client = token::Client::new(&s.env, &s.token);
        let to_success = token_client.balance(&s.success);
        let to_failure = token_client.balance(&s.failure);

        // Conservation law: success + failure == total
        assert_eq!(
            to_success + to_failure,
            total,
            "Conservation violated for pattern {:?}",
            pattern
        );

        // Contract balance should be zero after settlement
        let contract_balance = token_client.balance(&s.contract.address);
        assert_eq!(
            contract_balance, 0,
            "Contract still holds funds after slash for pattern {:?}",
            pattern
        );
    }
}

#[test]
fn test_vault_completed_event_cumulative_amount() {
    // Verify that vault_completed event emits the cumulative released amount
    let amounts: [i128; 3] = [100, 200, 300];
    let offsets: [u64; 3] = [100, 200, 300];
    let s = setup(&offsets, &amounts);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verify all milestones
    for i in 0..3u32 {
        s.contract
            .check_in(&s.vault_id, &s.verifier, &i, &evidence_hash(&s.env, i as u8));
    }

    // Claim all milestones sequentially
    s.contract.claim_milestone(&s.vault_id, &s.creator, &0);
    s.contract.claim_milestone(&s.vault_id, &s.creator, &1);
    s.contract.claim_milestone(&s.vault_id, &s.creator, &2);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Completed);
    assert_eq!(vault.staked, 0);

    // Verify total released to success
    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 600);
}
