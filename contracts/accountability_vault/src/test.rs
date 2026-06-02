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
    #[allow(dead_code)]
    token_admin_client: token::StellarAssetClient<'static>,
    creator: Address,
    verifier: Address,
    guardian: Address,
    success: Address,
    failure: Address,
    vault_id: String,
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
    let guardian = Address::generate(&env);
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
            released: false,
        });
    }

    let end = 1_000 + milestone_due_offsets.iter().max().copied().unwrap_or(0);
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
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
        token_admin_client,
        creator,
        verifier,
        guardian,
        success,
        failure,
        vault_id,
    }
}

// ── existing lifecycle tests ─────────────────────────────────────────────────

#[test]
fn test_create_and_stake() {
    let s = setup(&[100], &[500]);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Draft);

    s.contract.stake(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Active);
    assert_eq!(vault.staked, 500);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.creator), 0);
}

#[test]
fn test_check_in_and_claim_success() {
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.vault_id, &s.creator);

    s.contract.check_in(&s.vault_id, &s.verifier, &0);
    s.contract.check_in(&s.vault_id, &s.verifier, &1);

    s.contract.claim(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Completed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 1000);
}

#[test]
fn test_slash_on_miss() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Advance past the deadline without any check-in.
    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss(&s.vault_id);

    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Failed);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 500);
}

#[test]
fn test_withdraw_draft_cancels() {
    let s = setup(&[100], &[500]);
    s.contract.withdraw(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.status, VaultStatus::Cancelled);
}

#[test]
#[should_panic]
fn test_claim_before_all_verified_fails() {
    let s = setup(&[100, 200], &[300, 700]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.check_in(&s.vault_id, &s.verifier, &0);
    // Second milestone not yet verified -> claim must fail.
    s.contract.claim(&s.vault_id, &s.creator);
}

#[test]
#[should_panic]
fn test_slash_before_deadline_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    s.contract.slash_on_miss(&s.vault_id);
}

// ── issue #368: balance delta assertion in stake ─────────────────────────────

#[test]
fn test_stake_records_balance_delta_as_staked() {
    // For a standard token (no fee on transfer) the delta equals vault.amount.
    let s = setup(&[100], &[800]);
    s.contract.stake(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault.staked, 800);
    assert_eq!(vault.status, VaultStatus::Active);
}

#[test]
#[should_panic]
fn test_stake_unauthorized_non_creator_fails() {
    let s = setup(&[100], &[500]);
    let other = Address::generate(&s.env);
    s.contract.stake(&s.vault_id, &other);
}

#[test]
#[should_panic]
fn test_stake_double_stake_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);
    // Second stake on an Active vault must fail with AlreadyStaked / NotDraft.
    s.contract.stake(&s.vault_id, &s.creator);
}

// ── issue #370: stake_from allowance-based variant ───────────────────────────

#[test]
fn test_stake_from_with_sufficient_allowance() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let spender = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &1_000);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 1_000,
            due_date: 1_200,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &1_000, &success, &failure, &1_200,
        &milestones, &guardian,
    );

    // Creator approves spender to spend 1_000 tokens on their behalf.
    let token_client = token::Client::new(&env, &token);
    token_client.approve(&creator, &spender, &1_000, &200);

    contract.stake_from(&vault_id, &creator, &spender);

    let vault = contract.get_vault(&vault_id);
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
    let guardian = Address::generate(&env);
    let spender = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &1_000);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 1_000,
            due_date: 1_200,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &1_000, &success, &failure, &1_200,
        &milestones, &guardian,
    );

    // Approve only 500 — less than the 1_000 vault amount.
    let token_client = token::Client::new(&env, &token);
    token_client.approve(&creator, &spender, &500, &200);

    // Must fail with InsufficientAllowance.
    contract.stake_from(&vault_id, &creator, &spender);
}

#[test]
#[should_panic]
fn test_stake_from_non_creator_from_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let non_creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let spender = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&non_creator, &1_000);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 1_000,
            due_date: 1_200,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &1_000, &success, &failure, &1_200,
        &milestones, &guardian,
    );

    // `from` is not the creator — must be rejected with Unauthorized.
    contract.stake_from(&vault_id, &non_creator, &spender);
}

// ── issue #372: extend_deadline with dual auth ───────────────────────────────

#[test]
fn test_extend_deadline_success() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let vault_before = s.contract.get_vault(&s.vault_id);
    let old_end = vault_before.end_timestamp;

    let new_end = old_end + 500;
    s.contract.extend_deadline(&s.creator, &new_end);

    let vault_after = s.contract.get_vault(&s.vault_id);
    assert_eq!(vault_after.end_timestamp, new_end);
    assert_eq!(vault_after.status, VaultStatus::Active);
}

#[test]
#[should_panic]
fn test_extend_deadline_on_draft_fails() {
    let s = setup(&[100], &[500]);
    // Vault is Draft — extend_deadline must reject with NotActive.
    s.contract.extend_deadline(&s.creator, &2_000);
}

#[test]
#[should_panic]
fn test_extend_deadline_after_deadline_passed_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Advance past the end_timestamp.
    s.env.ledger().set_timestamp(2_000);
    s.contract.extend_deadline(&s.creator, &3_000);
}

#[test]
#[should_panic]
fn test_extend_deadline_not_greater_than_current_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let vault = s.contract.get_vault(&s.vault_id);
    // Pass the same end_timestamp — must fail with InvalidDeadline.
    s.contract.extend_deadline(&s.creator, &vault.end_timestamp);
}

#[test]
#[should_panic]
fn test_extend_deadline_milestone_exceeds_new_end_fails() {
    // milestone due_date = 1_100, vault end = 1_100.
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    // Try to extend to 1_050 — milestone due_date (1_100) > new_end (1_050).
    s.contract.extend_deadline(&s.creator, &1_050);
}

#[test]
#[should_panic]
fn test_extend_deadline_wrong_creator_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let impostor = Address::generate(&s.env);
    s.contract.extend_deadline(&impostor, &2_000);
}

// ── issue #364: verifier threshold validation in create_vault ────────────────

#[test]
#[should_panic]
fn test_create_vault_invalid_threshold_exceeds_verifiers_fails() {
    // threshold=2 with only 1 verifier must fail with InvalidThreshold.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, _) = create_token(&env, &token_admin);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    // threshold=2 but only 1 verifier — must fail with InvalidThreshold.
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 2u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &500, &success, &failure, &1_200,
        &milestones, &guardian,
    );
}

#[test]
#[should_panic]
fn test_create_vault_zero_threshold_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, _) = create_token(&env, &token_admin);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 0u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &500, &success, &failure, &1_200,
        &milestones, &guardian,
    );
}

// ── issue #363: oracle-driven check_in path ──────────────────────────────────

#[test]
fn test_oracle_check_in_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let oracle = Address::generate(&env);
    let s = setup_with_oracle(&[100, 200], &[400, 600], Some(oracle.clone()));
    s.contract.stake(&s.vault_id, &s.creator);

    // Oracle confirms both milestones.
    s.contract.check_in(&s.vault_id, &oracle, &0);
    s.contract.check_in(&s.vault_id, &oracle, &1);

    s.contract.claim(&s.vault_id, &s.creator);
    let vault = s.contract.get_vault(&s.vault_id);
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
    s.contract.stake(&s.vault_id, &s.creator);

    // The human verifier can still check in even when an oracle is set.
    s.contract.check_in(&s.vault_id, &s.verifier, &0);

    let vault = s.contract.get_vault(&s.vault_id);
    assert!(vault.milestones.get(0).unwrap().verified);
}

#[test]
#[should_panic]
fn test_unauthorized_caller_check_in_fails() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.vault_id, &s.creator);

    let random = Address::generate(&s.env);
    // Neither verifier nor oracle — must fail with Unauthorized.
    s.contract.check_in(&s.vault_id, &random, &0);
}

#[test]
#[should_panic]
fn test_oracle_not_set_random_caller_check_in_fails() {
    // No oracle configured; only the verifier is authorized.
    let s = setup_with_oracle(&[100], &[500], None);
    s.contract.stake(&s.vault_id, &s.creator);

    let fake_oracle = Address::generate(&s.env);
    s.contract.check_in(&s.vault_id, &fake_oracle, &0);
}

#[test]
fn test_vault_has_oracle_field_when_set() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let oracle = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "goal"),
            amount: 500,
            due_date: 1_200,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &Some(oracle.clone()),
        &token,
        &500,
        &success,
        &failure,
        &1_200,
        &milestones,
        &guardian,
    );

    let vault = contract.get_vault(&vault_id);
    assert_eq!(vault.oracle, Some(oracle));
}

#[test]
fn test_vault_oracle_field_is_none_when_not_set() {
    let s = setup(&[100], &[500]);
    let vault = s.contract.get_vault(&s.vault_id);
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
    let guardian = Address::generate(&env);
    let spender = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "goal"),
            amount: 500,
            due_date: 1_200,
            verified: false,
            released: false,
        },
    ];
    let vault_id = String::from_str(&env, "v1");
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &Some(oracle.clone()),
        &token,
        &500,
        &success,
        &failure,
        &1_200,
        &milestones,
        &guardian,
    );

    let token_client = token::Client::new(&env, &token);
    token_client.approve(&creator, &spender, &500, &200);

    // Backend drives staking via allowance.
    contract.stake_from(&vault_id, &creator, &spender);
    assert_eq!(contract.get_vault(&vault_id).status, VaultStatus::Active);

    // Oracle confirms the milestone.
    contract.check_in(&vault_id, &oracle, &0);
    assert!(contract.get_vault(&vault_id).milestones.get(0).unwrap().verified);

    // Claim releases funds.
    contract.claim(&vault_id, &creator);
    assert_eq!(contract.get_vault(&vault_id).status, VaultStatus::Completed);
    assert_eq!(token_client.balance(&success), 500);
}

// ── issue #352: checks-effects-interactions ordering tests ───────────────────

#[test]
fn test_cei_slash_on_miss_state_is_terminal_before_transfer() {
    // After slash_on_miss the vault must be in Failed terminal state with
    // staked == 0 (CEI: state persisted before the external token transfer).
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss();

    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Failed);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.failure), 500);
}

#[test]
fn test_cei_claim_state_is_terminal_before_transfer() {
    // After claim the vault must be in Completed terminal state with staked == 0
    // (CEI: state persisted before the external token transfer).
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.check_in(&s.verifier, &0);
    s.contract.claim(&s.creator);

    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Completed);
    assert_eq!(vault.staked, 0);

    let token_client = token::Client::new(&s.env, &s.token);
    assert_eq!(token_client.balance(&s.success), 500);
}

#[test]
fn test_cei_slash_cannot_be_triggered_twice() {
    // After a successful slash_on_miss the vault is Failed; a second call must
    // fail with NotActive — the CEI state update prevents double-slash.
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss();

    let result = s.contract.try_slash_on_miss();
    assert!(result.is_err());
}

#[test]
fn test_cei_claim_cannot_be_triggered_twice() {
    // After a successful claim the vault is Completed; a second call must fail
    // with NotActive — the CEI state update prevents double-claim.
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.check_in(&s.verifier, &0);
    s.contract.claim(&s.creator);

    let result = s.contract.try_claim(&s.creator);
    assert!(result.is_err());
}

// ── issue #357: emergency pause / unpause tests ──────────────────────────────

#[test]
#[should_panic]
fn test_pause_blocks_slash_on_miss() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.emergency_pause(&s.guardian);

    s.env.ledger().set_timestamp(2_000);
    // Must fail with Paused.
    s.contract.slash_on_miss();
}

#[test]
#[should_panic]
fn test_pause_blocks_claim() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.check_in(&s.verifier, &0);
    s.contract.emergency_pause(&s.guardian);

    // Must fail with Paused.
    s.contract.claim(&s.creator);
}

#[test]
#[should_panic]
fn test_pause_blocks_withdraw_active() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.emergency_pause(&s.guardian);

    // Must fail with Paused.
    s.contract.withdraw(&s.creator);
}

#[test]
fn test_unpause_allows_slash_on_miss() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.emergency_pause(&s.guardian);
    s.contract.emergency_unpause(&s.guardian);

    s.env.ledger().set_timestamp(2_000);
    s.contract.slash_on_miss();

    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Failed);
}

#[test]
fn test_unpause_allows_claim() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);
    s.contract.check_in(&s.verifier, &0);
    s.contract.emergency_pause(&s.guardian);
    s.contract.emergency_unpause(&s.guardian);

    s.contract.claim(&s.creator);

    let vault = s.contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Completed);
}

#[test]
#[should_panic]
fn test_non_guardian_cannot_pause() {
    let s = setup(&[100], &[500]);
    s.contract.stake(&s.creator);

    let impostor = Address::generate(&s.env);
    // impostor is not the vault guardian — must fail with Unauthorized.
    s.contract.emergency_pause(&impostor);
}

#[test]
fn test_pause_does_not_block_draft_withdraw() {
    // Cancelling a Draft vault does not transfer tokens; the pause only
    // blocks the active-vault settlement paths.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &500, &success, &failure, &1_200,
        &milestones, &guardian,
    );

    // Pause before staking (vault is still Draft).
    contract.emergency_pause(&guardian);

    // Draft-path withdraw (cancel) must still succeed.
    contract.withdraw(&creator);
    let vault = contract.get_vault();
    assert_eq!(vault.status, VaultStatus::Cancelled);
}

// ── issue #364: M-of-N multi-verifier check_in tests ─────────────────────────

#[test]
fn test_multi_verifier_single_approval_insufficient_for_threshold_two() {
    // With 2 verifiers and threshold=2, a single approval does not verify the milestone.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier1.clone(), verifier2.clone()],
        threshold: 2u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &500, &success, &failure, &1_200,
        &milestones, &guardian,
    );
    contract.stake(&creator);

    // Only verifier1 approves — threshold not yet reached.
    contract.check_in(&verifier1, &0);
    let vault = contract.get_vault();
    assert!(!vault.milestones.get(0).unwrap().verified);
}

#[test]
fn test_multi_verifier_both_approve_verifies_milestone() {
    // With 2 verifiers and threshold=2, both approving flips the milestone to verified.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier1.clone(), verifier2.clone()],
        threshold: 2u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &500, &success, &failure, &1_200,
        &milestones, &guardian,
    );
    contract.stake(&creator);

    // Both verifiers approve — threshold reached.
    contract.check_in(&verifier1, &0);
    contract.check_in(&verifier2, &0);

    let vault = contract.get_vault();
    assert!(vault.milestones.get(0).unwrap().verified);
}

#[test]
#[should_panic]
fn test_multi_verifier_double_approval_by_same_verifier_fails() {
    // The same verifier may not approve the same milestone twice.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier1.clone(), verifier2.clone()],
        threshold: 2u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &500, &success, &failure, &1_200,
        &milestones, &guardian,
    );
    contract.stake(&creator);

    contract.check_in(&verifier1, &0);
    // Same verifier approves again — must fail with AlreadyApproved.
    contract.check_in(&verifier1, &0);
}

#[test]
fn test_multi_verifier_threshold_one_of_two_single_approval_sufficient() {
    // With 2 verifiers and threshold=1, a single approval verifies the milestone.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &500);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier1.clone(), verifier2.clone()],
        threshold: 1u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m"),
            amount: 500,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &500, &success, &failure, &1_200,
        &milestones, &guardian,
    );
    contract.stake(&creator);

    // Only verifier1 approves — sufficient for threshold=1.
    contract.check_in(&verifier1, &0);
    let vault = contract.get_vault();
    assert!(vault.milestones.get(0).unwrap().verified);
}

#[test]
fn test_multi_verifier_2of2_full_claim_flow() {
    // Two verifiers, threshold=2: both must approve each milestone before claim.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier1 = Address::generate(&env);
    let verifier2 = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);
    token_admin_client.mint(&creator, &1_000);

    let contract_id = env.register_contract(None, AccountabilityVault);
    let contract = AccountabilityVaultClient::new(&env, &contract_id);

    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier1.clone(), verifier2.clone()],
        threshold: 2u32,
    };
    let milestones = vec![
        &env,
        Milestone {
            title: String::from_str(&env, "m1"),
            amount: 400,
            due_date: 1_100,
            verified: false,
        },
        Milestone {
            title: String::from_str(&env, "m2"),
            amount: 600,
            due_date: 1_200,
            verified: false,
        },
    ];
    contract.create_vault(
        &creator, &verifier_set, &None, &token, &1_000, &success, &failure, &1_200,
        &milestones, &guardian,
    );
    contract.stake(&creator);

    // Milestone 0: both verifiers must approve.
    contract.check_in(&verifier1, &0);
    assert!(!contract.get_vault().milestones.get(0).unwrap().verified);
    contract.check_in(&verifier2, &0);
    assert!(contract.get_vault().milestones.get(0).unwrap().verified);

    // Milestone 1: both verifiers must approve.
    contract.check_in(&verifier1, &1);
    contract.check_in(&verifier2, &1);
    assert!(contract.get_vault().milestones.get(1).unwrap().verified);

    // All milestones verified — claim succeeds.
    contract.claim(&creator);
    assert_eq!(contract.get_vault().status, VaultStatus::Completed);

    let token_client = token::Client::new(&env, &token);
    assert_eq!(token_client.balance(&success), 1_000);
}

// ── gas benchmarks ───────────────────────────────────────────────────────────

#[test]
fn test_gas_benchmarks_10_milestones() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let creator = Address::generate(&env);
    let verifier = Address::generate(&env);
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);

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
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };

    // 1. Measure create_vault
    env.budget().reset_default();
    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &total_amount,
        &success,
        &failure,
        &end_timestamp,
        &milestones,
        &guardian,
    );
    let create_cpu = env.budget().cpu_instruction_cost();
    let create_mem = env.budget().memory_bytes_cost();

    // 2. Measure stake
    env.budget().reset_default();
    contract.stake(&vault_id, &creator);
    let stake_cpu = env.budget().cpu_instruction_cost();
    let stake_mem = env.budget().memory_bytes_cost();

    // 3. Measure check_in
    env.budget().reset_default();
    contract.check_in(&vault_id, &verifier, &0);
    let check_in_cpu = env.budget().cpu_instruction_cost();
    let check_in_mem = env.budget().memory_bytes_cost();

    // Verify all remaining milestones so we can claim
    for i in 1..milestone_count {
        contract.check_in(&vault_id, &verifier, &i);
    }

    // 4. Measure claim
    env.budget().reset_default();
    contract.claim(&vault_id, &creator);
    let claim_cpu = env.budget().cpu_instruction_cost();
    let claim_mem = env.budget().memory_bytes_cost();

    std::println!("=== Gas Benchmarks (10 Milestones) ===");
    std::println!("create_vault: CPU = {}, Memory = {}", create_cpu, create_mem);
    std::println!("stake:        CPU = {}, Memory = {}", stake_cpu, stake_mem);
    std::println!("check_in:     CPU = {}, Memory = {}", check_in_cpu, check_in_mem);
    std::println!("claim:        CPU = {}, Memory = {}", claim_cpu, claim_mem);

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
    let guardian = Address::generate(&env);
    let success = Address::generate(&env);
    let failure = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let (token, token_admin_client) = create_token(&env, &token_admin);

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
    let verifier_set = VerifierSet {
        verifiers: vec![&env, verifier.clone()],
        threshold: 1u32,
    };

    contract.create_vault(
        &vault_id,
        &creator,
        &verifier_set,
        &None,
        &token,
        &total_amount,
        &success,
        &failure,
        &end_timestamp,
        &milestones,
        &guardian,
    );

    contract.stake(&creator);

    // Advance past the overall deadline to allow slash
    env.ledger().set_timestamp(end_timestamp + 1);

    // Measure slash_on_miss
    env.budget().reset_default();
    contract.slash_on_miss(&vault_id);
    let slash_cpu = env.budget().cpu_instruction_cost();
    let slash_mem = env.budget().memory_bytes_cost();

    std::println!("=== Gas Benchmarks Slash (10 Milestones) ===");
    std::println!("slash_on_miss: CPU = {}, Memory = {}", slash_cpu, slash_mem);

    assert!(slash_cpu < 900_000);
    assert!(slash_mem < 250_000);
}
