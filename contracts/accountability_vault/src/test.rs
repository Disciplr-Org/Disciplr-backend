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
    contract_id: Address,
    token: Address,
    creator: Address,
    verifier: Address,
    success: Address,
    failure: Address,
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
    );

    Setup {
        env,
        contract,
        contract_id,
        token,
        creator,
        verifier,
        success,
        failure,
        vault_id,
    }
}

fn verify_all_milestones(s: &Setup, count: u32) {
    for index in 0..count {
        s.contract.check_in(
            &s.vault_id,
            &s.verifier,
            &index,
            &evidence_hash(&s.env, index as u8 + 1),
        );
    }
}

fn claim_and_assert_solvency(s: &Setup, claim_order: &[u32], amounts: &[i128]) {
    let token_client = token::Client::new(&s.env, &s.token);
    let total: i128 = amounts.iter().sum();
    let mut expected_staked = total;
    let mut expected_paid = 0i128;

    assert_eq!(token_client.balance(&s.contract_id), total);
    assert_eq!(s.contract.get_vault(&s.vault_id).staked, total);

    for index in claim_order {
        let payout = amounts[*index as usize];
        s.contract.claim_milestone(&s.vault_id, &s.verifier, index);

        expected_staked -= payout;
        expected_paid += payout;

        let vault = s.contract.get_vault(&s.vault_id);
        assert_eq!(vault.staked, expected_staked);
        assert!(vault.staked >= 0);
        assert_eq!(token_client.balance(&s.contract_id), expected_staked);
        assert_eq!(token_client.balance(&s.success), expected_paid);
    }

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Completed);
    assert_eq!(vault.staked, 0);
    assert_eq!(token_client.balance(&s.contract_id), 0);
    assert_eq!(token_client.balance(&s.success), total);
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
fn test_partial_payout_rejects_zero_amount_boundaries() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, _) = create_token(&env, &token_admin);
    let contract_id = env.register(AccountabilityVault, ());
    let contract = AccountabilityVaultClient::new(&env, &contract_id);
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier],
        threshold: 1,
    };

    let mut zero_total_milestones = vec![&env];
    zero_total_milestones.push_back(Milestone {
        title: String::from_str(&env, "zero"),
        amount: 0,
        due_date: 1_100,
        verified: false,
        released: false,
    });
    let zero_total = contract.try_create_vault(
        &String::from_str(&env, "zero-total"),
        &creator,
        &verifier_set,
        &None,
        &token,
        &0,
        &success,
        &failure,
        &1_100,
        &zero_total_milestones,
    );
    assert!(matches!(zero_total, Err(Ok(Error::InvalidAmount))));

    let mut zero_milestone = vec![&env];
    zero_milestone.push_back(Milestone {
        title: String::from_str(&env, "zero"),
        amount: 0,
        due_date: 1_100,
        verified: false,
        released: false,
    });
    zero_milestone.push_back(Milestone {
        title: String::from_str(&env, "one"),
        amount: 1,
        due_date: 1_100,
        verified: false,
        released: false,
    });
    let zero_partial = contract.try_create_vault(
        &String::from_str(&env, "zero-partial"),
        &creator,
        &verifier_set,
        &None,
        &token,
        &1,
        &success,
        &failure,
        &1_100,
        &zero_milestone,
    );
    assert!(matches!(zero_partial, Err(Ok(Error::InvalidAmount))));
}

#[test]
fn test_partial_payout_unit_amounts_keep_escrow_solvency() {
    let amounts = [1, 1, 1];
    let s = setup(&[10, 20, 30], &amounts);
    s.contract.stake(&s.vault_id, &s.creator);
    verify_all_milestones(&s, amounts.len() as u32);

    claim_and_assert_solvency(&s, &[0, 1, 2], &amounts);
}

#[test]
fn test_partial_payout_uneven_amounts_keep_exact_remainders() {
    let amounts = [333, 333, 334];
    let s = setup(&[10, 20, 30], &amounts);
    s.contract.stake(&s.vault_id, &s.creator);
    verify_all_milestones(&s, amounts.len() as u32);

    claim_and_assert_solvency(&s, &[2, 0, 1], &amounts);
}

#[test]
fn test_partial_payout_i128_max_boundary_does_not_overflow_or_overdraw() {
    let amounts = [i128::MAX - 2, 1, 1];
    let s = setup(&[10, 20, 30], &amounts);
    s.contract.stake(&s.vault_id, &s.creator);
    verify_all_milestones(&s, amounts.len() as u32);

    claim_and_assert_solvency(&s, &[1, 2, 0], &amounts);
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
