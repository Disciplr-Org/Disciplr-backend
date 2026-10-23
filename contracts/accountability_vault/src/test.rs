#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, vec, Address, BytesN, Env, String,
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

    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &oracle,
        &token,
        &total,
        &success,
        &failure,
        &end,
        &milestones,
        &guardian,
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
    for i in 0..amounts.len() {
        s.contract.claim_milestone(&s.vault_id, &s.creator, &(i as u32));
        released_so_far += amounts[i];

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

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None::<Address>,
        &token,
        &100,
        &success,
        &failure,
        &1_100u64,
        &milestones,
        &guardian,
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

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None::<Address>,
        &token,
        &100,
        &success,
        &failure,
        &1_100u64,
        &milestones,
        &guardian,
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

    let result = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None::<Address>,
        &token,
        &100,
        &success,
        &failure,
        &1_100u64,
        &milestones,
        &guardian,
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
    let offsets: Vec<u64> = (1..=n).map(|i| i as u64 * 10).collect();

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

    let offsets: Vec<u64> = (1..=13).map(|i| i as u64 * 10).collect();
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

    // Exactly 128 chars -> OK
    let title_128 = String::from_str(
        &env,
        "012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678",
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
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones_ok,
        &guardian,
    );
    assert!(res.is_ok());

    // 129 chars -> TitleTooLong
    let title_129 = String::from_str(
        &env,
        "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789",
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
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones_err,
        &guardian,
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
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones,
        &creator, // guardian is creator
    );
    assert_eq!(res, Err(Ok(Error::InvalidGuardian)));

    // Case 2: guardian == success_destination -> InvalidGuardian
    let res_succ = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones,
        &success, // guardian is success destination
    );
    assert_eq!(res_succ, Err(Ok(Error::InvalidGuardian)));

    // Case 3: guardian is sole verifier -> InvalidGuardian
    let res_sole_verifier = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones,
        &verifier, // guardian is the only verifier
    );
    assert_eq!(res_sole_verifier, Err(Ok(Error::InvalidGuardian)));

    // Case 4: valid distinct guardian -> OK
    let guardian = Address::generate(&env);
    let res_ok = contract.try_create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &100,
        &success,
        &failure,
        &2_000,
        &milestones,
        &guardian,
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
    assert_eq!(s.token.balance(&s.failure), 100);
    assert_eq!(s.token.balance(&s.contract.address), 0);
}

#[test]
fn test_dispute_expires_and_slash_proceeds() {
    let s = setup(&[100], &[100]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Ledger timestamp is 1_000. End date is 1_100.
    // Guardian puts vault into dispute for 100 seconds: disputed_until = 1_100.
    s.contract.admin_dispute(&s.vault_id, &s.guardian, &100);

    // Advance to 1_050: status is Disputed -> StatusNotActive
    s.env.ledger().set_timestamp(1_050);
    let res_slash_early = s.contract.try_slash_on_miss(&s.vault_id);
    assert_eq!(res_slash_early, Err(Ok(Error::StatusNotActive)));

    // Advance past disputed_until and past end_date (e.g. 1_101)
    s.env.ledger().set_timestamp(1_101);
    // Dispute expired! It should automatically resume / allow slash_on_miss.
    let slash_res = s.contract.try_slash_on_miss(&s.vault_id);
    assert!(slash_res.is_ok());
    assert_eq!(s.token.balance(&s.failure), 100);
    assert_eq!(s.token.balance(&s.contract.address), 0);
}

#[test]
fn test_claim_milestone_blocked_when_paused() {
    let s = setup(&[100, 200], &[50, 50]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Verifier verifies milestone 0
    s.contract.verify_milestone(&s.vault_id, &0, &s.verifier);

    // Guardian pauses the vault
    s.contract.emergency_pause(&s.vault_id, &s.guardian, &86_400);

    let pre_creator_bal = s.token.balance(&s.creator);
    let pre_contract_bal = s.token.balance(&s.contract.address);

    // Attempt to claim milestone while paused -> Error::Paused
    let claim_res = s.contract.try_claim_milestone(&s.vault_id, &0, &s.creator);
    assert_eq!(claim_res, Err(Ok(Error::Paused)));

    // Assert NO balance changes occurred
    assert_eq!(s.token.balance(&s.creator), pre_creator_bal);
    assert_eq!(s.token.balance(&s.contract.address), pre_contract_bal);

    // Guardian unpauses
    s.contract.emergency_unpause(&s.vault_id, &s.guardian);

    // Now claim_milestone succeeds
    let claim_res2 = s.contract.try_claim_milestone(&s.vault_id, &0, &s.creator);
    assert!(claim_res2.is_ok());
    assert_eq!(s.token.balance(&s.creator), pre_creator_bal + 50);
}

#[test]
fn test_reclaim_cannot_drain_other_vaults() {
    let s = setup(&[100], &[1_000]);
    let token_client = token::Client::new(&s.env, &s.token);

    // Victim creates and stakes 1000
    s.contract.stake(&s.vault_id, &s.creator);
    assert_eq!(token_client.balance(&s.contract.address), 1_000);
    assert_eq!(token_client.balance(&s.creator), 0);

    // Attacker creates a separate Draft vault (staked == 0)
    let attacker = Address::generate(&s.env);
    let attacker_vault_id = String::from_str(&s.env, "attacker-vault");
    let attacker_guardian = Address::generate(&s.env);
    let verifier_set = VerifierSet {
        verifiers: vec![&s.env, s.verifier.clone()],
        threshold: 1,
    };
    let attacker_milestones = vec![
        &s.env,
        Milestone {
            title: String::from_str(&s.env, "m"),
            amount: 1_000,
            due_date: 1_100,
            verified: false,
            released: false,
        },
    ];

    s.contract.create_vault(
        &attacker_vault_id,
        &attacker,
        &verifier_set,
        &None,
        &s.token,
        &1_000,
        &s.success,
        &s.failure,
        &1_100,
        &attacker_milestones,
        &attacker_guardian,
    );

    assert_eq!(token_client.balance(&attacker), 0);

    // Attacker attempts to call reclaim_after_settlement.
    // Since reclaim_after_settlement was removed from the contract, invoking it fails.
    let call_res = s.env.try_invoke_contract::<(), soroban_sdk::Val>(
        &s.contract.address,
        &Symbol::new(&s.env, "reclaim_after_settlement"),
        vec![&s.env, attacker_vault_id.to_val(), s.token.to_val()],
    );
    assert!(call_res.is_err());

    // Assert victim's stake remains in the contract and attacker's balance is unchanged
    assert_eq!(token_client.balance(&s.contract.address), 1_000);
    assert_eq!(token_client.balance(&attacker), 0);

    let victim_vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(victim_vault.staked, 1_000);
    assert_eq!(victim_vault.status, VaultStatus::Active);
}

#[test]
fn test_balance_covers_outstanding_stakes() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let token_admin = Address::generate(&env);
    let (token, token_admin_client) = create_token(&env, &token_admin);
    let token_client = token::Client::new(&env, &token);

    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    // Seeded linear congruential PRNG
    let mut prng_state: u64 = 0x12345678_abcdef01;
    let mut next_random = || -> u64 {
        prng_state = prng_state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        prng_state
    };

    struct TestVaultInfo {
        id: String,
        creator: Address,
        verifier: Address,
        guardian: Address,
    }

    let mut vaults: std::vec::Vec<TestVaultInfo> = std::vec::Vec::new();

    // Loop of randomized create/stake/check_in/claim/slash/withdraw operations over multiple vaults
    for step in 0..100 {
        let op = next_random() % 7;
        match op {
            0 => {
                // Create a new vault
                let v_idx = vaults.len();
                let creator = Address::generate(&env);
                let verifier = Address::generate(&env);
                let success = Address::generate(&env);
                let failure = Address::generate(&env);
                let guardian = Address::generate(&env);
                let vault_id = String::from_str(&env, &std::format!("v-{}", v_idx));

                let amount = ((next_random() % 500) + 100) as i128;
                token_admin_client.mint(&creator, &amount);

                let verifier_set = VerifierSet {
                    verifiers: vec![&env, verifier.clone()],
                    threshold: 1,
                };
                let milestones = vec![
                    &env,
                    Milestone {
                        title: String::from_str(&env, "m1"),
                        amount: amount / 2,
                        due_date: env.ledger().timestamp() + 500,
                        verified: false,
                        released: false,
                    },
                    Milestone {
                        title: String::from_str(&env, "m2"),
                        amount: amount - (amount / 2),
                        due_date: env.ledger().timestamp() + 1_000,
                        verified: false,
                        released: false,
                    },
                ];

                let _ = contract.try_create_vault(
                    &vault_id,
                    &creator,
                    &verifier_set,
                    &None,
                    &token,
                    &amount,
                    &success,
                    &failure,
                    &(env.ledger().timestamp() + 1_000),
                    &milestones,
                    &guardian,
                );

                vaults.push(TestVaultInfo {
                    id: vault_id,
                    creator,
                    verifier,
                    guardian,
                });
            }
            1 => {
                // Stake in an existing vault
                if !vaults.is_empty() {
                    let idx = (next_random() as usize) % vaults.len();
                    let v = &vaults[idx];
                    let _ = contract.try_stake(&v.id, &v.creator);
                }
            }
            2 => {
                // Check in milestone
                if !vaults.is_empty() {
                    let idx = (next_random() as usize) % vaults.len();
                    let v = &vaults[idx];
                    let m_idx = (next_random() % 2) as u32;
                    let _ = contract.try_check_in(
                        &v.id,
                        &v.verifier,
                        &m_idx,
                        &evidence_hash(&env, (step % 255) as u8),
                    );
                }
            }
            3 => {
                // Claim milestone
                if !vaults.is_empty() {
                    let idx = (next_random() as usize) % vaults.len();
                    let v = &vaults[idx];
                    let m_idx = (next_random() % 2) as u32;
                    let _ = contract.try_claim_milestone(&v.id, &v.creator, &m_idx);
                }
            }
            4 => {
                // Bulk claim
                if !vaults.is_empty() {
                    let idx = (next_random() as usize) % vaults.len();
                    let v = &vaults[idx];
                    let _ = contract.try_claim(&v.id, &v.creator);
                }
            }
            5 => {
                // Slash on miss
                if !vaults.is_empty() {
                    let idx = (next_random() as usize) % vaults.len();
                    let v = &vaults[idx];
                    let _ = contract.try_slash_on_miss(&v.id);
                }
            }
            6 => {
                // Withdraw or advance time
                if !vaults.is_empty() {
                    let idx = (next_random() as usize) % vaults.len();
                    let v = &vaults[idx];
                    let _ = contract.try_withdraw(&v.id, &v.creator);
                }
                env.ledger().set_timestamp(env.ledger().timestamp() + 200);
            }
            _ => {}
        }

        // Global invariant check:
        // Contract token balance must always be >= the sum of outstanding staked funds across all vaults.
        let mut total_staked: i128 = 0;
        for v in &vaults {
            if let Ok(Ok(vault_record)) = contract.try_get_vault(&v.id) {
                total_staked += vault_record.staked;
            }
        }
        let contract_balance = token_client.balance(&contract_id);
        assert!(
            contract_balance >= total_staked,
            "Invariant violation at step {}: contract balance ({}) < outstanding staked ({})",
            step,
            contract_balance,
            total_staked
        );
    }
}



