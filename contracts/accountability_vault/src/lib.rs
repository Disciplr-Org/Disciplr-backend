#![no_std]
//! Disciplr Accountability Vault
//!
//! A Soroban smart contract implementing programmable time-locked capital vaults
//! for accountability staking. A creator stakes funds toward a goal with one or
//! more milestones. A designated verifier confirms check-ins / milestone
//! completion. On success the staked capital is released to the
//! `success_destination`; on a missed deadline the capital is slashed to the
//! `failure_destination` (e.g. a charity or forfeit address).
//!
//! Lifecycle: create_vault -> stake | stake_from -> (check_in)* -> claim | slash_on_miss
//! Funds movement is modeled via the SEP-41 token client (`stake`, `stake_from`,
//! `claim`, `slash_on_miss`, `withdraw`). The contract enforces the state machine,
//! authorization, and deadline rules on-chain.
//!
//! Extended features:
//! - `stake_from`: allowance-based staking via SEP-41 `transfer_from`, enabling
//!   backend-driven flows without requiring the creator to call the contract directly.
//!   The staked amount is measured as the actual contract balance delta to guard
//!   against fee-on-transfer tokens.
//! - `extend_deadline`: joint creator+verifier extension of `end_timestamp` while
//!   the vault is `Active` and before the original deadline passes.
//! - oracle support in `check_in`: an optional authorized oracle address may
//!   confirm milestones in addition to the designated verifier; the source
//!   (oracle vs verifier) is included in the emitted event for backend parsing.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, String, Vec,
};

/// Storage keys for the contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The vault configuration and current state.
    Vault,
    /// Per-milestone check-in record, keyed by milestone index.
    CheckIn(u32),
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

/// A single accountability milestone within a vault.
#[contracttype]
#[derive(Clone)]
pub struct Milestone {
    pub title: String,
    /// Portion of the staked amount tied to this milestone.
    pub amount: i128,
    /// UNIX timestamp (seconds) by which the milestone must be checked in.
    pub due_date: u64,
    /// Whether the verifier or oracle has confirmed this milestone.
    pub verified: bool,
}

/// Full on-chain vault record.
#[contracttype]
#[derive(Clone)]
pub struct Vault {
    pub creator: Address,
    /// The party authorized to confirm check-ins / milestones.
    pub verifier: Address,
    /// Optional oracle address that may confirm milestones alongside the verifier.
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
}

#[contract]
pub struct AccountabilityVault;

#[contractimpl]
impl AccountabilityVault {
    /// Creates a new accountability vault in `Draft` state.
    ///
    /// Validates that the staked amount is positive, the deadline is in the
    /// future, milestone amounts sum to `amount`, and that there is at least one
    /// milestone. The creator must authorize the call.
    ///
    /// `oracle` is an optional address that may confirm milestones via `check_in`
    /// in addition to the designated verifier. Pass `None` for human-only verification.
    pub fn create_vault(
        env: Env,
        creator: Address,
        verifier: Address,
        oracle: Option<Address>,
        token: Address,
        amount: i128,
        success_destination: Address,
        failure_destination: Address,
        end_timestamp: u64,
        milestones: Vec<Milestone>,
    ) -> Result<(), Error> {
        creator.require_auth();

        if env.storage().instance().has(&DataKey::Vault) {
            return Err(Error::AlreadyInitialized);
        }
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

        let vault = Vault {
            creator: creator.clone(),
            verifier,
            oracle,
            token,
            amount,
            staked: 0,
            success_destination,
            failure_destination,
            end_timestamp,
            status: VaultStatus::Draft,
            milestones,
        };
        env.storage().instance().set(&DataKey::Vault, &vault);
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
    pub fn stake(env: Env, from: Address) -> Result<(), Error> {
        from.require_auth();
        let mut vault: Vault = Self::load(&env)?;

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
        env.storage().instance().set(&DataKey::Vault, &vault);
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
    pub fn stake_from(env: Env, from: Address, spender: Address) -> Result<(), Error> {
        spender.require_auth();
        let mut vault: Vault = Self::load(&env)?;

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
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events()
            .publish((String::from_str(&env, "vault_staked"), from), vault.staked);
        Ok(())
    }

    /// Records a check-in confirming a milestone before its due date.
    ///
    /// Authorized callers are the vault's designated `verifier` or, if configured,
    /// the optional `oracle` address. The emitted event includes a `source` topic
    /// (`"verifier"` or `"oracle"`) so the backend event parser can distinguish
    /// automated oracle confirmations from human verifier sign-offs.
    pub fn check_in(env: Env, caller: Address, milestone_index: u32) -> Result<(), Error> {
        caller.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }

        let is_verifier = caller == vault.verifier;
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

        milestone.verified = true;
        vault.milestones.set(milestone_index, milestone);
        env.storage()
            .instance()
            .set(&DataKey::CheckIn(milestone_index), &env.ledger().timestamp());
        env.storage().instance().set(&DataKey::Vault, &vault);

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
    /// Requires authorization from both the vault's `creator` and `verifier`,
    /// ensuring neither party can unilaterally push out the deadline.
    ///
    /// Constraints:
    /// - Vault must be `Active`.
    /// - The current ledger time must be before the existing `end_timestamp`
    ///   (extensions after the deadline has already passed are not allowed).
    /// - `new_end_timestamp` must be strictly greater than the current `end_timestamp`.
    /// - All existing milestone `due_date` values must be `<= new_end_timestamp`
    ///   (the milestones-within-deadline invariant is preserved).
    pub fn extend_deadline(
        env: Env,
        creator: Address,
        verifier: Address,
        new_end_timestamp: u64,
    ) -> Result<(), Error> {
        creator.require_auth();
        verifier.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        if verifier != vault.verifier {
            return Err(Error::Unauthorized);
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
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (String::from_str(&env, "deadline_extended"), creator),
            (old_end, new_end_timestamp),
        );
        Ok(())
    }

    /// Slashes the staked capital to the `failure_destination` once the vault
    /// deadline has passed and not all milestones were verified. Permissionless:
    /// anyone may trigger the slash after the deadline (e.g. a backend keeper).
    pub fn slash_on_miss(env: Env) -> Result<(), Error> {
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if env.ledger().timestamp() <= vault.end_timestamp {
            return Err(Error::DeadlineNotReached);
        }
        if Self::all_verified(&vault) {
            return Err(Error::MilestonesIncomplete);
        }

        let client = token::Client::new(&env, &vault.token);
        client.transfer(
            &env.current_contract_address(),
            &vault.failure_destination,
            &vault.staked,
        );

        vault.status = VaultStatus::Failed;
        let slashed = vault.staked;
        vault.staked = 0;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (
                String::from_str(&env, "vault_slashed"),
                vault.failure_destination.clone(),
            ),
            slashed,
        );
        Ok(())
    }

    /// Releases the staked capital to the `success_destination` once every
    /// milestone has been verified. Callable by the creator or verifier.
    pub fn claim(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if caller != vault.creator && caller != vault.verifier {
            return Err(Error::Unauthorized);
        }
        if !Self::all_verified(&vault) {
            return Err(Error::MilestonesIncomplete);
        }

        let client = token::Client::new(&env, &vault.token);
        client.transfer(
            &env.current_contract_address(),
            &vault.success_destination,
            &vault.staked,
        );

        vault.status = VaultStatus::Completed;
        let released = vault.staked;
        vault.staked = 0;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (
                String::from_str(&env, "vault_completed"),
                vault.success_destination.clone(),
            ),
            released,
        );
        Ok(())
    }

    /// Cancels an unfunded (`Draft`) vault, or refunds the creator if the vault
    /// was funded but never activated against any milestone. Only the creator
    /// may withdraw; activated vaults with verified check-ins cannot be unwound.
    pub fn withdraw(env: Env, creator: Address) -> Result<(), Error> {
        creator.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.status == VaultStatus::Draft {
            vault.status = VaultStatus::Cancelled;
            env.storage().instance().set(&DataKey::Vault, &vault);
            env.events()
                .publish((String::from_str(&env, "vault_cancelled"), creator), 0i128);
            return Ok(());
        }

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if Self::any_verified(&vault) {
            return Err(Error::Unauthorized);
        }
        if vault.staked <= 0 {
            return Err(Error::NothingToWithdraw);
        }

        let client = token::Client::new(&env, &vault.token);
        client.transfer(&env.current_contract_address(), &creator, &vault.staked);

        let refunded = vault.staked;
        vault.staked = 0;
        vault.status = VaultStatus::Cancelled;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (String::from_str(&env, "vault_withdrawn"), creator),
            refunded,
        );
        Ok(())
    }

    /// Read-only accessor returning the current vault record.
    pub fn get_vault(env: Env) -> Result<Vault, Error> {
        Self::load(&env)
    }

    // ── internal helpers ────────────────────────────────────────────────

    fn load(env: &Env) -> Result<Vault, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)
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

    /// Reclaim any residual token balance left in the contract after a vault
    /// has reached a terminal settlement. This transfers the contract's token
    /// balance to the vault creator.
    ///
    /// Requirements:
    /// - Caller must be the `creator` (authorization enforced)
    /// - Vault must be settled (no staked amount remaining)
    pub fn reclaim_after_settlement(
        env: Env,
        vault: Vault,
        token_address: Address,
    ) -> Result<(), Error> {
        // Ensure the caller is the creator
        let creator_addr = Address::from_string(&vault.creator);
        creator_addr.require_auth();

        // Conservatively require the tracked staked amount to be zero before
        // sweeping any residuals. This keeps semantics clear: reclaiming is
        // only allowed once the vault has no outstanding stake.
        if vault.amount != 0 {
            return Err(Error::StakedRemaining);
        }

        // Use the on-chain contract address as the token holder to sweep from
        let contract_addr = env.current_contract_address();
        let token = TokenClient::new(&env, &token_address);

        // Query contract's token balance and transfer any leftover to creator
        let bal: i128 = token.balance(&contract_addr);
        if bal > 0 {
            token.transfer(&contract_addr, &creator_addr, &bal);
        }

        Ok(())
    }
}

mod test;
