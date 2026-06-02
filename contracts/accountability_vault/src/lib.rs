#![no_std]
//! Disciplr Accountability Vault
//!
//! A Soroban smart contract implementing programmable time-locked capital vaults
//! for accountability staking. A creator stakes funds toward a goal with one or
//! more milestones. A designated verifier set confirms check-ins / milestone
//! completion via M-of-N threshold approval. On success the staked capital is
//! released to the `success_destination`; on a missed deadline the capital is
//! slashed to the `failure_destination` (e.g. a charity or forfeit address).
//!
//! Lifecycle: create_vault -> stake | stake_from -> (check_in)* -> claim | claim_milestone | slash_on_miss
//! Funds movement is modeled via the SEP-41 token client (`stake`, `stake_from`,
//! `claim`, `slash_on_miss`, `withdraw`). The contract enforces the state machine,
//! authorization, and deadline rules on-chain.
//!
//! Security invariants:
//! - Checks-Effects-Interactions: vault state (status, staked) is persisted to
//!   storage BEFORE any external token::Client call in `slash_on_miss`, `claim`,
//!   and `withdraw`. This ensures the vault reaches a terminal state even if the
//!   downstream token call panics or re-enters.
//! - Emergency pause: a guardian address set at `create_vault` time may call
//!   `emergency_pause` to block `slash_on_miss`, `claim`, and `withdraw` during
//!   disputes or incidents. The same guardian may call `emergency_unpause`.
//! - M-of-N verifier approvals: `check_in` requires `approval_threshold` distinct
//!   verifier (or oracle) approvals before flipping a milestone to verified.
//!   Double-approval by the same address is rejected with `Error::AlreadyApproved`.
//!
//! Extended features:
//! - `stake_from`: allowance-based staking via SEP-41 `transfer_from`, enabling
//!   backend-driven flows without requiring the creator to call the contract directly.
//!   The staked amount is measured as the actual contract balance delta to guard
//!   against fee-on-transfer tokens.
//! - `extend_deadline`: joint creator + all-verifiers extension of `end_timestamp`
//!   while the vault is `Active` and before the original deadline passes.
//! - oracle support in `check_in`: an optional authorized oracle address may
//!   confirm milestones in addition to the designated verifier set; the source
//!   (`"oracle"` vs `"verifier"`) is included in the emitted event for backend parsing.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String, Vec,
};

/// Storage keys for the contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The vault configuration and current state.
    Vault,
    /// Per-milestone check-in timestamp (set when the milestone reaches the approval threshold).
    CheckIn(u32),
    /// Per-milestone list of addresses that have approved, used for M-of-N tracking.
    MilestoneApprovals(u32),
}

/// Lifecycle state of the vault, mirroring the backend `PersistedVault.status`.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultStatus {
    /// Created but not yet funded.
    Draft = 0,
    /// Funded and counting down to its deadline.
    Active = 1,
    /// All milestones verified; funds released to success destination.
    Completed = 2,
    /// Deadline passed without completion; funds slashed.
    Failed = 3,
    /// Cancelled by the creator before activation.
    Cancelled = 4,
}

/// Verifier configuration for M-of-N milestone approval.
///
/// Grouping these two fields into a single parameter keeps `create_vault`
/// within Soroban's 10-parameter limit while preserving readable call sites.
#[contracttype]
#[derive(Clone)]
pub struct VerifierSet {
    /// Set of addresses authorized to approve milestones via `check_in`.
    pub verifiers: Vec<Address>,
    /// Minimum number of distinct approvals required to verify a milestone.
    pub threshold: u32,
}

/// A single accountability milestone within a vault.
#[contracttype]
#[derive(Clone)]
pub struct Milestone {
    pub title: String,
    /// Portion of the staked amount tied to this milestone.
    pub amount: i128,
    /// UNIX timestamp (seconds) by which the milestone must be checked in.
    pub due_date: u64,
    /// Whether enough distinct verifiers / oracle have approved this milestone.
    pub verified: bool,
    /// Whether this milestone's funds have already been released via `claim_milestone`.
    pub released: bool,
}

/// Full on-chain vault record.
#[contracttype]
#[derive(Clone)]
pub struct Vault {
    pub creator: Address,
    /// Set of addresses authorized to approve milestones via `check_in`.
    /// A milestone is verified once at least `approval_threshold` distinct members
    /// (or the oracle) have approved it.
    pub verifiers: Vec<Address>,
    /// Minimum number of distinct approvals required to verify a milestone (M of N).
    pub approval_threshold: u32,
    /// Optional oracle address that may confirm milestones alongside the verifier set.
    /// Enables automated milestone verification driven by the backend oracle job.
    pub oracle: Option<Address>,
    /// SEP-41 token used for staking.
    pub token: Address,
    /// Total staked amount (sum of milestone amounts).
    pub amount: i128,
    /// Actual amount received by the contract via `stake` or `stake_from`,
    /// measured as the balance delta to handle fee-on-transfer tokens correctly.
    pub staked: i128,
    /// Destination for released funds on success.
    pub success_destination: Address,
    /// Destination for slashed funds on a missed deadline.
    pub failure_destination: Address,
    /// Overall vault deadline (seconds since epoch, UTC).
    pub end_timestamp: u64,
    pub status: VaultStatus,
    pub milestones: Vec<Milestone>,
    /// Address authorized to pause and unpause this vault in emergencies.
    pub guardian: Address,
    /// When true, `slash_on_miss`, `claim`, and active `withdraw` are blocked.
    pub paused: bool,
}

/// Errors surfaced to callers. Numbered for stable client mapping.
#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InvalidDeadline = 4,
    NoMilestones = 5,
    NotDraft = 6,
    NotActive = 7,
    Unauthorized = 8,
    AlreadyStaked = 9,
    MilestoneIndexOutOfRange = 10,
    MilestoneAlreadyVerified = 11,
    DeadlinePassed = 12,
    DeadlineNotReached = 13,
    MilestonesIncomplete = 14,
    NothingToWithdraw = 15,
    AmountMismatch = 16,
    /// `stake_from` was called but the spender's token allowance from `from`
    /// is less than the vault's staking amount.
    InsufficientAllowance = 17,
    /// Operation blocked because the vault is currently paused by the guardian.
    Paused = 18,
    /// The caller has already approved this milestone and may not approve again.
    AlreadyApproved = 19,
    /// The `verifiers` list provided to `create_vault` is empty.
    NoVerifiers = 20,
    /// `approval_threshold` is zero or exceeds the number of verifiers.
    InvalidThreshold = 21,
    /// `reclaim_after_settlement` was called while `staked` is non-zero.
    StakedRemaining = 22,
}

#[contract]
pub struct AccountabilityVault;

#[contractimpl]
impl AccountabilityVault {
    /// Creates a new accountability vault in `Draft` state.
    ///
    /// `verifiers` is the set of addresses authorized to confirm milestones via
    /// `check_in`. `approval_threshold` is the minimum distinct approvals needed
    /// to mark a milestone verified (M-of-N; must be >= 1 and <= verifiers.len()).
    /// `guardian` is the address that may pause/unpause the vault in emergencies.
    ///
    /// `oracle` is an optional address that may confirm milestones in addition to
    /// the verifier set. Pass `None` for human-only verification.
    pub fn create_vault(
        env: Env,
        vault_id: String,
        creator: Address,
        verifier_set: VerifierSet,
        oracle: Option<Address>,
        token: Address,
        amount: i128,
        success_destination: Address,
        failure_destination: Address,
        end_timestamp: u64,
        milestones: Vec<Milestone>,
        guardian: Address,
    ) -> Result<(), Error> {
        creator.require_auth();

        let key = DataKey::Vault(vault_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyInitialized);
        }
        if verifier_set.verifiers.is_empty() {
            return Err(Error::NoVerifiers);
        }
        if verifier_set.threshold == 0 || verifier_set.threshold > verifier_set.verifiers.len() {
            return Err(Error::InvalidThreshold);
        }
        let verifiers = verifier_set.verifiers;
        let approval_threshold = verifier_set.threshold;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if end_timestamp <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }
        if milestones.is_empty() {
            return Err(Error::NoMilestones);
        }

        let mut sum: i128 = 0;
        for m in milestones.iter() {
            if m.amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            if m.due_date > end_timestamp {
                return Err(Error::InvalidDeadline);
            }
            sum += m.amount;
        }
        if sum != amount {
            return Err(Error::AmountMismatch);
        }

        // Ensure all milestones are initialised with released = false.
        let mut init_milestones = Vec::new(&env);
        for m in milestones.iter() {
            init_milestones.push_back(Milestone {
                title: m.title,
                amount: m.amount,
                due_date: m.due_date,
                verified: m.verified,
                released: false,
            });
        }

        let vault = Vault {
            creator: creator.clone(),
            verifiers,
            approval_threshold,
            oracle,
            token,
            amount,
            staked: 0,
            success_destination,
            failure_destination,
            end_timestamp,
            status: VaultStatus::Draft,
            milestones,
            guardian,
            paused: false,
        };
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        env.events()
            .publish((String::from_str(&env, "vault_created"), creator), amount);
        Ok(())
    }

    /// Funds the vault by transferring `amount` of the staking token from the
    /// creator into the contract, moving the vault from `Draft` to `Active`.
    ///
    /// The actual received amount is measured as the contract balance delta to
    /// correctly account for fee-on-transfer tokens. If the received amount is
    /// less than the declared `vault.amount`, the call is rejected with
    /// `Error::AmountMismatch`.
    pub fn stake(env: Env, vault_id: String, from: Address) -> Result<(), Error> {
        from.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if vault.status != VaultStatus::Draft {
            return Err(Error::NotDraft);
        }
        if from != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.staked != 0 {
            return Err(Error::AlreadyStaked);
        }

        let client = token::Client::new(&env, &vault.token);
        let contract_addr = env.current_contract_address();
        let balance_before = client.balance(&contract_addr);
        client.transfer(&from, &contract_addr, &vault.amount);
        let received = client.balance(&contract_addr) - balance_before;
        if received < vault.amount {
            return Err(Error::AmountMismatch);
        }

        vault.staked = received;
        vault.status = VaultStatus::Active;
        let key = DataKey::Vault(vault_id);
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        env.events()
            .publish((String::from_str(&env, "vault_staked"), from), vault.staked);
        Ok(())
    }

    /// Allowance-based staking variant using SEP-41 `transfer_from`.
    ///
    /// Enables a backend or authorized spender account to drive the staking flow
    /// without requiring the creator to call the contract directly. The creator
    /// must first call `token.approve(spender, amount)` to grant the allowance.
    ///
    /// - `from`: the creator / token holder whose balance is pulled.
    /// - `spender`: the account that holds the allowance and must authorize this call.
    ///
    /// Like `stake`, the received amount is measured via balance delta to handle
    /// fee-on-transfer tokens. Returns `Error::InsufficientAllowance` when the
    /// spender's allowance from `from` is below the vault's staking amount.
    pub fn stake_from(
        env: Env,
        vault_id: String,
        from: Address,
        spender: Address,
    ) -> Result<(), Error> {
        spender.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if vault.status != VaultStatus::Draft {
            return Err(Error::NotDraft);
        }
        if from != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.staked != 0 {
            return Err(Error::AlreadyStaked);
        }

        let client = token::Client::new(&env, &vault.token);

        // Validate the spender's allowance covers the required stake before
        // attempting the transfer, to surface a clear error on under-approval.
        let allowance = client.allowance(&from, &spender);
        if allowance < vault.amount {
            return Err(Error::InsufficientAllowance);
        }

        let contract_addr = env.current_contract_address();
        let balance_before = client.balance(&contract_addr);
        client.transfer_from(&spender, &from, &contract_addr, &vault.amount);
        let received = client.balance(&contract_addr) - balance_before;
        if received < vault.amount {
            return Err(Error::AmountMismatch);
        }

        vault.staked = received;
        vault.status = VaultStatus::Active;
        let key = DataKey::Vault(vault_id);
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        env.events()
            .publish((String::from_str(&env, "vault_staked"), from), vault.staked);
        Ok(())
    }

    /// Records an approval for a milestone from a verifier or oracle, flipping
    /// `Milestone.verified` once `approval_threshold` distinct approvals are
    /// accumulated.
    ///
    /// Double-approval by the same address is rejected with `Error::AlreadyApproved`.
    /// The emitted event includes a `source` topic (`"verifier"` or `"oracle"`) so
    /// the backend event parser can distinguish automated oracle confirmations from
    /// human verifier sign-offs.
    pub fn check_in(env: Env, caller: Address, milestone_index: u32) -> Result<(), Error> {
        caller.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }

        let is_verifier = vault.verifiers.iter().any(|v| v == caller);
        let is_oracle = vault
            .oracle
            .as_ref()
            .map(|o| o == &caller)
            .unwrap_or(false);
        if !is_verifier && !is_oracle {
            return Err(Error::Unauthorized);
        }

        if milestone_index >= vault.milestones.len() {
            return Err(Error::MilestoneIndexOutOfRange);
        }

        let mut milestone = vault.milestones.get(milestone_index).unwrap();
        if milestone.verified {
            return Err(Error::MilestoneAlreadyVerified);
        }
        if env.ledger().timestamp() > milestone.due_date {
            return Err(Error::DeadlinePassed);
        }

        // M-of-N approval tracking: load or initialize the per-milestone approval list.
        let approvals_key = DataKey::MilestoneApprovals(milestone_index);
        let mut approvals: Vec<Address> = env
            .storage()
            .instance()
            .get(&approvals_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Prevent double-approval by the same address.
        if approvals.iter().any(|a| a == caller) {
            return Err(Error::AlreadyApproved);
        }

        approvals.push_back(caller.clone());
        env.storage().instance().set(&approvals_key, &approvals);

        // Flip the milestone verified and record the timestamp once the threshold is reached.
        if approvals.len() >= vault.approval_threshold {
            milestone.verified = true;
            vault.milestones.set(milestone_index, milestone);
            env.storage()
                .instance()
                .set(&DataKey::CheckIn(milestone_index), &env.ledger().timestamp());
            env.storage().instance().set(&DataKey::Vault, &vault);
        }

        let source = if is_oracle {
            String::from_str(&env, "oracle")
        } else {
            String::from_str(&env, "verifier")
        };
        env.events().publish(
            (
                String::from_str(&env, "milestone_checked_in"),
                caller,
                source,
            ),
            milestone_index,
        );
        Ok(())
    }

    /// Extends the vault's `end_timestamp` to a later point in time.
    ///
    /// Requires authorization from the vault's `creator` and all `verifiers`,
    /// ensuring no single party can unilaterally push out the deadline.
    ///
    /// Constraints:
    /// - Vault must be `Active`.
    /// - The current ledger time must be before the existing `end_timestamp`.
    /// - `new_end_timestamp` must be strictly greater than the current `end_timestamp`.
    /// - All existing milestone `due_date` values must be `<= new_end_timestamp`.
    pub fn extend_deadline(
        env: Env,
        vault_id: String,
        creator: Address,
        new_end_timestamp: u64,
    ) -> Result<(), Error> {
        creator.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        // All verifiers must co-sign the extension; no single party can push out the deadline.
        for v in vault.verifiers.iter() {
            v.require_auth();
        }

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if env.ledger().timestamp() >= vault.end_timestamp {
            return Err(Error::DeadlinePassed);
        }
        if new_end_timestamp <= vault.end_timestamp {
            return Err(Error::InvalidDeadline);
        }
        // Preserve the invariant: every milestone due_date <= end_timestamp.
        for m in vault.milestones.iter() {
            if m.due_date > new_end_timestamp {
                return Err(Error::InvalidDeadline);
            }
        }

        let old_end = vault.end_timestamp;
        vault.end_timestamp = new_end_timestamp;
        let key = DataKey::Vault(vault_id);
        env.storage().persistent().set(&key, &vault);
        Self::extend_ttl(&env, &key);

        env.events().publish(
            (String::from_str(&env, "deadline_extended"), creator),
            (old_end, new_end_timestamp),
        );
        Ok(())
    }

    /// Slashes the staked capital to the `failure_destination` once the vault
    /// deadline has passed and not all milestones were verified. Permissionless:
    /// anyone may trigger the slash after the deadline (e.g. a backend keeper).
    ///
    /// Checks-Effects-Interactions: vault status is set to `Failed` and `staked`
    /// is zeroed in storage BEFORE the external token transfer is executed,
    /// ensuring the terminal state is committed even if the transfer call panics.
    pub fn slash_on_miss(env: Env) -> Result<(), Error> {
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if vault.paused {
            return Err(Error::Paused);
        }
        if env.ledger().timestamp() <= vault.end_timestamp {
            return Err(Error::DeadlineNotReached);
        }
        if Self::all_verified(&vault) {
            return Err(Error::MilestonesIncomplete);
        }

        // CEI: capture transfer values, update and persist state, then call external token.
        let slashed = vault.staked;
        let failure_destination = vault.failure_destination.clone();
        let token_addr = vault.token.clone();
        vault.status = VaultStatus::Failed;
        vault.staked = 0;
        env.storage().instance().set(&DataKey::Vault, &vault);

        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &failure_destination,
            &slashed,
        );

        env.events().publish(
            (
                String::from_str(&env, "vault_slashed"),
                failure_destination,
            ),
            slashed,
        );
        Ok(())
    }

    /// Releases the staked capital to the `success_destination` once every
    /// milestone has been verified. Callable by the creator or any member of
    /// the verifier set.
    ///
    /// Checks-Effects-Interactions: vault status is set to `Completed` and
    /// `staked` is zeroed in storage BEFORE the external token transfer,
    /// ensuring the terminal state is committed even if the transfer call panics.
    pub fn claim(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if vault.paused {
            return Err(Error::Paused);
        }
        let is_authorized =
            caller == vault.creator || vault.verifiers.iter().any(|v| v == caller);
        if !is_authorized {
            return Err(Error::Unauthorized);
        }
        if !Self::all_verified(&vault) {
            return Err(Error::MilestonesIncomplete);
        }
        // Guard: if any milestone was already claimed via claim_milestone, reject
        // bulk claim to prevent double-release confusion.
        if Self::any_released(&vault) {
            return Err(Error::PartiallyReleased);
        }

        // CEI: capture transfer values, update and persist state, then call external token.
        let released = vault.staked;
        let success_destination = vault.success_destination.clone();
        let token_addr = vault.token.clone();
        vault.status = VaultStatus::Completed;
        vault.staked = 0;
        env.storage().instance().set(&DataKey::Vault, &vault);

        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &success_destination,
            &released,
        );

        env.events().publish(
            (
                String::from_str(&env, "vault_completed"),
                success_destination,
            ),
            released,
        );
        Ok(())
    }

    /// Releases a single verified milestone's amount to the `success_destination`.
    ///
    /// Callable by the creator or verifier once the milestone at `index` is
    /// verified (via `check_in`). Tracks released milestones on the `Milestone`
    /// struct's `released` flag to prevent double-claiming.
    ///
    /// When the last milestone is claimed, the vault automatically transitions
    /// to `Completed`.
    pub fn claim_milestone(env: Env, caller: Address, index: u32) -> Result<(), Error> {
        caller.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if caller != vault.creator && caller != vault.verifier {
            return Err(Error::Unauthorized);
        }
        if index >= vault.milestones.len() {
            return Err(Error::MilestoneIndexOutOfRange);
        }

        let mut milestone = vault.milestones.get(index).unwrap();
        if !milestone.verified {
            return Err(Error::MilestonesIncomplete);
        }
        if milestone.released {
            return Err(Error::MilestoneAlreadyReleased);
        }

        let payout = milestone.amount;

        // Mark the milestone as released and update vault.
        milestone.released = true;
        vault.milestones.set(index, milestone);
        vault.staked -= payout;

        let client = token::Client::new(&env, &vault.token);
        client.transfer(
            &env.current_contract_address(),
            &vault.success_destination,
            &payout,
        );

        env.events().publish(
            (
                String::from_str(&env, "milestone_claimed"),
                vault.success_destination.clone(),
            ),
            (index, payout),
        );

        // Transition to Completed if every milestone has now been released.
        if Self::all_released(&vault) {
            vault.status = VaultStatus::Completed;
            env.events().publish(
                (
                    String::from_str(&env, "vault_completed"),
                    vault.success_destination.clone(),
                ),
                vault.amount,
            );
        }

        env.storage().instance().set(&DataKey::Vault, &vault);
        Ok(())
    }

    /// Cancels an unfunded (`Draft`) vault, or refunds the creator if the vault
    /// was funded but never activated against any milestone. Only the creator
    /// may withdraw; vaults with any verified check-ins cannot be unwound.
    ///
    /// Checks-Effects-Interactions: vault state is updated and persisted BEFORE
    /// the external token transfer for the active-vault refund path.
    pub fn withdraw(env: Env, creator: Address) -> Result<(), Error> {
        creator.require_auth();
        let mut vault: Vault = Self::load(&env, &vault_id)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.status == VaultStatus::Draft {
            vault.status = VaultStatus::Cancelled;
            let key = DataKey::Vault(vault_id);
            env.storage().persistent().set(&key, &vault);
            Self::extend_ttl(&env, &key);

            env.events()
                .publish((String::from_str(&env, "vault_cancelled"), creator), 0i128);
            return Ok(());
        }

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if vault.paused {
            return Err(Error::Paused);
        }
        if Self::any_verified(&vault) {
            return Err(Error::Unauthorized);
        }
        if vault.staked == 0 {
            return Err(Error::NothingToWithdraw);
        }

        // CEI: capture transfer values, update and persist state, then call external token.
        let refunded = vault.staked;
        let token_addr = vault.token.clone();
        vault.staked = 0;
        vault.status = VaultStatus::Cancelled;
        env.storage().instance().set(&DataKey::Vault, &vault);

        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &creator,
            &refunded,
        );

        env.events().publish(
            (String::from_str(&env, "vault_withdrawn"), creator),
            refunded,
        );
        Ok(())
    }

    /// Pauses the vault, blocking `slash_on_miss`, `claim`, and active `withdraw`.
    ///
    /// Only the `guardian` address set at vault creation may call this function.
    /// Use to halt settlement during disputes or detected incidents.
    pub fn emergency_pause(env: Env, guardian: Address) -> Result<(), Error> {
        guardian.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if guardian != vault.guardian {
            return Err(Error::Unauthorized);
        }
        vault.paused = true;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events()
            .publish((String::from_str(&env, "vault_paused"), guardian), true);
        Ok(())
    }

    /// Unpauses the vault, re-enabling `slash_on_miss`, `claim`, and `withdraw`.
    ///
    /// Only the `guardian` address set at vault creation may call this function.
    pub fn emergency_unpause(env: Env, guardian: Address) -> Result<(), Error> {
        guardian.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if guardian != vault.guardian {
            return Err(Error::Unauthorized);
        }
        vault.paused = false;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events()
            .publish((String::from_str(&env, "vault_unpaused"), guardian), false);
        Ok(())
    }

    /// Read-only accessor returning the current vault record.
    pub fn get_vault(env: Env, vault_id: String) -> Result<Vault, Error> {
        Self::load(&env, &vault_id)
    }

    /// Sweeps any residual token balance held by the contract to the vault creator
    /// after a terminal settlement. Only the creator may call this, and only once
    /// `staked` has been zeroed by `claim`, `slash_on_miss`, or `withdraw`.
    pub fn reclaim_after_settlement(env: Env, token_address: Address) -> Result<(), Error> {
        let vault: Vault = Self::load(&env)?;
        vault.creator.require_auth();

        // Only sweep after the vault has no outstanding stake.
        if vault.staked != 0 {
            return Err(Error::StakedRemaining);
        }

        let contract_addr = env.current_contract_address();
        let client = token::Client::new(&env, &token_address);
        let bal = client.balance(&contract_addr);
        if bal > 0 {
            client.transfer(&contract_addr, &vault.creator, &bal);
        }
        Ok(())
    }

    // ── internal helpers ────────────────────────────────────────────────

    fn load(env: &Env, vault_id: &String) -> Result<Vault, Error> {
        let key = DataKey::Vault(vault_id.clone());
        let vault = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;
        Self::extend_ttl(env, &key);
        Ok(vault)
    }

    fn extend_ttl(env: &Env, key: &DataKey) {
        // Persistent storage TTL bumping: 30 days threshold, 30 days bump.
        // Approx 17280 ledgers per day.
        let threshold = 30 * 17280;
        let bump = 30 * 17280;
        env.storage().persistent().extend_ttl(key, threshold, bump);
    }

    fn all_verified(vault: &Vault) -> bool {
        for m in vault.milestones.iter() {
            if !m.verified {
                return false;
            }
        }
        true
    }

    fn any_verified(vault: &Vault) -> bool {
        for m in vault.milestones.iter() {
            if m.verified {
                return true;
            }
        }
        false
    }
}

mod test;
