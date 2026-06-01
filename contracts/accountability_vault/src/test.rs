#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, vec, Address, Env, String,
};

fn create_token(env: &Env, admin: &Address) -> (Address, token::StellarAssetClient<'static>) {
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let address = sac.address();
    (
        address.clone(),
        token::StellarAssetClient::new(env, &address),
    )
}

struct Setup {
    env: Env,
    contract: AccountabilityVaultClient<'static>,
    token: Address,
    token_admin_client: token::StellarAssetClient<'static>,
    creator: Address,
    verifier: Address,
    success: Address,
    failure: Address,
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
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    let total: i128 = amounts.iter().sum();
    token_admin_client.mint(&creator, &total);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let mut milestones = vec![&env];
    for (i, due) in milestone_due_offsets.iter().enumerate() {
        milestones.push_back(Milestone {
            title: String::from_str(&env, "m"),
            amount: amounts[i],
            due_date: 1_000 + due,
            verified: false,
        });
    }

    let end = 1_000 + milestone_due_offsets.iter().max().copied().unwrap_or(0);
    contract.create_vault(
        &creator,
        &verifier,
        &oracle,
        &token,
        &total,
        &success,
        &failure,
        &end,
        &milestones,
    );

    Setup {
        env,
        contract,
        token,
        token_admin_client,
        creator,
        verifier,
        success,
        failure,
    }
}

// ── existing lifecycle tests ─────────────────────────────────────────────────

#[test]
fn test_create_and_stake() {
    let s = setup(&[100], &[500]);
    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Draft);

    s.contract.stake(&s.creator);
    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 500);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.creator), 0);
}

#[test]
fn test_check_in_and_claim_success() {
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.creator);

    s.contract.check_in(&s.verifier, &0);
    s.contract.check_in(&s.verifier, &1);

    s.contract.claim(&s.creator);
    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Completed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 1000);
}

#[test]
fn test_slash_on_miss() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    // Advance past the deadline without any check-in.
    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss();

    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Failed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 500);
}

#[test]
fn test_withdraw_draft_cancels() {
    let s = setup(&[100], &[500]);
    s.contract.withdraw(&s.creator);
    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Cancelled);
}

#[test]
#[should_panic]
fn test_claim_before_all_verified_fails() {
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.creator);
    s.contract.check_in(&s.verifier, &0);
    // Second milestone not yet verified -> claim must fail.
    s.contract.claim(&s.creator);
}

#[test]
#[should_panic]
fn test_slash_before_deadline_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.slash_on_miss();
}

// ── issue #368: balance delta assertion in stake ─────────────────────────────

#[test]
fn test_stake_records_balance_delta_as_staked() {
    // For a standard token (no fee on transfer) the delta equals vault.amount.
    let s = setup(&[100], &[800]);
    s.contract.stake(&s.creator);
    let vault = s.contract.get_vault();
    assert_eq!(vault.staked, 800);
    assert_eq!(vault.status, VaultStatus::Active);
}

#[test]
#[should_panic]
fn test_stake_unauthorized_non_creator_fails() {
    let s = setup(&[100], &[500]);
    let other = Address::generate(&s.env);
    s.contract.stake(&other);
}

#[test]
#[should_panic]
fn test_stake_double_stake_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    // Second stake on an Active vault must fail with AlreadyStaked / NotDraft.
    s.contract.stake(&s.creator);
}

// ── issue #370: stake_from allowance-based variant ───────────────────────────

#[test]
fn test_stake_from_with_sufficient_allowance() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let spender = Address::generate(&env); // backend / authorized account
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &1_000);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 1_000,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier, &None, &token, &1_000, &success, &failure, &1_200, &milestones,
    );

    // Creator approves spender to spend 1_000 tokens on their behalf.
    let token_client = token::Client::new(&env, &token);
    token_client.approve(&creator, &spender, &1_000, &200);

    contract.stake_from(&creator, &spender);

    let vault = contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 1_000);
    assert_eq!(token_client.balance(&creator), 0);
}

#[test]
#[should_panic]
fn test_stake_from_insufficient_allowance_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let spender = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &1_000);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 1_000,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier, &None, &token, &1_000, &success, &failure, &1_200, &milestones,
    );

    // Approve only 500 — less than the 1_000 vault amount.
    let token_client = token::Client::new(&env, &token);
    token_client.approve(&creator, &spender, &500, &200);

    // Must fail with InsufficientAllowance.
    contract.stake_from(&creator, &spender);
}

#[test]
#[should_panic]
fn test_stake_from_non_creator_from_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let non_creator = Address::generate(&env);
    let spender = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&non_creator, &1_000);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 1_000,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier, &None, &token, &1_000, &success, &failure, &1_200, &milestones,
    );

    // `from` is not the creator — must be rejected with Unauthorized.
    contract.stake_from(&non_creator, &spender);
}

// ── issue #372: extend_deadline with dual auth ───────────────────────────────

#[test]
fn test_extend_deadline_success() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    let vault_before = s.contract.get_vault();
    let old_end = vault_before.end_timestamp;

    let new_end = old_end + 500;
    s.contract
        .extend_deadline(&s.creator, &s.verifier, &new_end);

    let vault_after = s.contract.get_vault();
    assert_eq!(vault_after.end_timestamp, new_end);
    assert_eq!(vault_after.status, VaultStatus::Active);
}

#[test]
#[should_panic]
fn test_extend_deadline_on_draft_fails() {
    let s = setup(&[100], &[500]);
    // Vault is Draft — extend_deadline must reject with NotActive.
    s.contract
        .extend_deadline(&s.creator, &s.verifier, &2_000);
}

#[test]
#[should_panic]
fn test_extend_deadline_after_deadline_passed_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    // Advance past the end_timestamp.
    s.env.ledger().set_timestamp(2_000);
    s.contract
        .extend_deadline(&s.creator, &s.verifier, &3_000);
}

#[test]
#[should_panic]
fn test_extend_deadline_not_greater_than_current_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    let vault = s.contract.get_vault();
    // Pass the same end_timestamp — must fail with InvalidDeadline.
    s.contract
        .extend_deadline(&s.creator, &s.verifier, &vault.end_timestamp);
}

#[test]
#[should_panic]
fn test_extend_deadline_milestone_exceeds_new_end_fails() {
    // milestone due_date = 1_100, vault end = 1_100.
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    // Try to extend to 1_050 — milestone due_date (1_100) > new_end (1_050).
    s.contract
        .extend_deadline(&s.creator, &s.verifier, &1_050);
}

#[test]
#[should_panic]
fn test_extend_deadline_wrong_creator_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    let impostor = Address::generate(&s.env);
    s.contract
        .extend_deadline(&impostor, &s.verifier, &2_000);
}

#[test]
#[should_panic]
fn test_extend_deadline_wrong_verifier_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    let impostor = Address::generate(&s.env);
    s.contract
        .extend_deadline(&s.creator, &impostor, &2_000);
}

// ── issue #363: oracle-driven check_in path ──────────────────────────────────

#[test]
fn test_oracle_check_in_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let oracle = Address::generate(&env);
    let s = setup_with_oracle(&[100, 200], &[400, 600], Some(oracle.clone()));
    s.contract.stake(&s.creator);

    // Oracle confirms both milestones.
    s.contract.check_in(&oracle, &0);
    s.contract.check_in(&oracle, &1);

    s.contract.claim(&s.creator);
    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Completed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 1_000);
}

#[test]
fn test_verifier_check_in_still_works_with_oracle_configured() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let oracle = Address::generate(&env);
    let s = setup_with_oracle(&[100], &[500], Some(oracle.clone()));
    s.contract.stake(&s.creator);

    // The human verifier can still check in even when an oracle is set.
    s.contract.check_in(&s.verifier, &0);

    let vault = s.contract.get_vault();
    assert!(vault.milestones.get(0).unwrap().verified);
}

#[test]
#[should_panic]
fn test_unauthorized_caller_check_in_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    let random = Address::generate(&s.env);
    // Neither verifier nor oracle — must fail with Unauthorized.
    s.contract.check_in(&random, &0);
}

#[test]
#[should_panic]
fn test_oracle_not_set_random_caller_check_in_fails() {
    // No oracle configured; only the verifier is authorized.
    let s = setup_with_oracle(&[100], &[500], None);
    s.contract.stake(&s.creator);

    let fake_oracle = Address::generate(&s.env);
    s.contract.check_in(&fake_oracle, &0);
}

#[test]
fn test_vault_has_oracle_field_when_set() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let oracle = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "goal"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator,
        &verifier,
        &Some(oracle.clone()),
        &token,
        &500,
        &success,
        &failure,
        &1_200,
        &milestones,
    );

    let vault = contract.get_vault();
    assert_eq!(vault.oracle, Some(oracle));
}


#[test]
fn test_vault_oracle_field_is_none_when_not_set() {
    let s = setup(&[100], &[500]);
    let vault = s.contract.get_vault();
    assert_eq!(vault.oracle, None);
}

// ── cross-feature: stake_from then oracle check_in then claim ────────────────

#[test]
fn test_stake_from_oracle_checkin_claim_full_flow() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let oracle = Address::generate(&env);
    let spender = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "goal"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator,
        &verifier,
        &Some(oracle.clone()),
        &token,
        &500,
        &success,
        &failure,
        &1_200,
        &milestones,
    );

    let token_client = token::Client::new(&env, &token);
    token_client.approve(&creator, &spender, &500, &200);

    // Backend drives staking via allowance.
    contract.stake_from(&creator, &spender);
    assert_eq!(contract.get_vault().status, VaultStatus::Active);

    // Oracle confirms the milestone.
    contract.check_in(&oracle, &0);
    assert!(contract.get_vault().milestones.get(0).unwrap().verified);

    // Claim releases funds.
    contract.claim(&creator);
    assert_eq!(contract.get_vault().status, VaultStatus::Completed);
    assert_eq!(token_client.balance(&success), 500);
}

#[test]
fn test_gas_benchmarks_10_milestones() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    
    // Setup 10 milestones
    let milestone_count = 10;
    let milestone_amount = 100i128;
    let total_amount = milestone_amount * (milestone_count as i128);
    token_admin_client.mint(&creator, &total_amount);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let mut milestones = vec![&env];
    for i in 0..milestone_count {
        milestones.push_back(Milestone {
            title: String::from_str(&env, "milestone"),
            amount: milestone_amount,
            due_date: 1_000 + (i as u64 + 1) * 100,
            verified: false,
        });
    }

    let end_timestamp = 1_000 + (milestone_count as u64) * 100;
    
    // 1. Measure create_vault
    env.budget().reset_default();
    contract.create_vault(
        &creator,
        &verifier,
        &None,
        &token,
        &total_amount,
        &success,
        &failure,
        &end_timestamp,
        &milestones,
    );
    let create_cpu = env.budget().cpu_instruction_cost();
    let create_mem = env.budget().memory_bytes_cost();
    
    // 2. Measure stake
    env.budget().reset_default();
    contract.stake(&creator);
    let stake_cpu = env.budget().cpu_instruction_cost();
    let stake_mem = env.budget().memory_bytes_cost();

    // 3. Measure check_in
    env.budget().reset_default();
    contract.check_in(&verifier, &0);
    let check_in_cpu = env.budget().cpu_instruction_cost();
    let check_in_mem = env.budget().memory_bytes_cost();

    // Verify all remaining milestones so we can claim
    for i in 1..milestone_count {
        contract.check_in(&verifier, &i);
    }

    // 4. Measure claim
    env.budget().reset_default();
    contract.claim(&creator);
    let claim_cpu = env.budget().cpu_instruction_cost();
    let claim_mem = env.budget().memory_bytes_cost();

    // Print values for baseline establishment
    std::println!("=== Gas Benchmarks (10 Milestones) ===");
    std::println!("create_vault: CPU = {}, Memory = {}", create_cpu, create_mem);
    std::println!("stake:        CPU = {}, Memory = {}", stake_cpu, stake_mem);
    std::println!("check_in:     CPU = {}, Memory = {}", check_in_cpu, check_in_mem);
    std::println!("claim:        CPU = {}, Memory = {}", claim_cpu, claim_mem);

    // Hard bounds assertions for 10 milestones to prevent unbounded growth/regressions
    assert!(create_cpu < 600_000);
    assert!(create_mem < 200_000);

    assert!(stake_cpu < 700_000);
    assert!(stake_mem < 200_000);

    assert!(check_in_cpu < 300_000);
    assert!(check_in_mem < 100_000);

    assert!(claim_cpu < 900_000);
    assert!(claim_mem < 250_000);
}

#[test]
fn test_gas_benchmarks_slash_on_miss_10_milestones() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    
    // Setup 10 milestones
    let milestone_count = 10;
    let milestone_amount = 100i128;
    let total_amount = milestone_amount * (milestone_count as i128);
    token_admin_client.mint(&creator, &total_amount);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let mut milestones = vec![&env];
    for i in 0..milestone_count {
        milestones.push_back(Milestone {
            title: String::from_str(&env, "milestone"),
            amount: milestone_amount,
            due_date: 1_000 + (i as u64 + 1) * 100,
            verified: false,
        });
    }

    let end_timestamp = 1_000 + (milestone_count as u64) * 100;
    
    contract.create_vault(
        &creator,
        &verifier,
        &None,
        &token,
        &total_amount,
        &success,
        &failure,
        &end_timestamp,
        &milestones,
    );
    
    contract.stake(&creator);

    // Advance past the overall deadline to allow slash
    env.ledger().set_timestamp(end_timestamp + 1);

    // Measure slash_on_miss
    env.budget().reset_default();
    contract.slash_on_miss();
    let slash_cpu = env.budget().cpu_instruction_cost();
    let slash_mem = env.budget().memory_bytes_cost();

    std::println!("=== Gas Benchmarks Slash (10 Milestones) ===");
    std::println!("slash_on_miss: CPU = {}, Memory = {}", slash_cpu, slash_mem);

    assert!(slash_cpu < 900_000);
    assert!(slash_mem < 250_000);
}



