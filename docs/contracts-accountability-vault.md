# Accountability Vault Contract Invariants

This document outlines the core structural and arithmetic invariants for the `accountability_vault` smart contract, particularly surrounding milestone amount distribution and solvency.

## Core Invariants

### 1. Milestone Sum Check
At vault creation (`create_vault`), the sum of all individual milestone amounts must equal the vault's total declared amount:
$$\sum_{i=0}^{N-1} \text{milestone\_amount}_i = \text{vault\_amount}$$
This invariant prevents under-collateralized or over-collateralized vault configurations and ensures milestone payouts map precisely to the locked vault balance.

### 2. Strict Solvency
The vault's tracked `staked` balance must never underflow or drift from the actual physical token balance of the contract:
$$\text{staked}_t = \text{total\_vault\_staked} - \sum \text{claimed\_milestones}_t$$
After each partial milestone payout (`claim_milestone`), the remainder is kept in the contract.
- Rounds and remainder distributions must be handled explicitly by specifying exact milestone divisions (e.g., distributing remainders across the last milestone).
- Rounded/uneven milestone amounts are supported as long as they sum exactly to the vault's total staked amount.

### 3. Terminal Zero-Staked Guarantee
When all milestones are claimed (`claim_milestone` is called for every index), or when a bulk `claim` / `slash_on_miss` is executed:
$$\text{staked}_{\text{final}} = 0$$
This is guaranteed by:
- Rejecting bulk `claim` if any milestone has already been claimed individually (`PartiallyReleased`).
- Tracking individual milestone releases via a `released: bool` flag to prevent double-claiming.
- Zeroing out `staked` during a terminal event before triggering token transfers (Checks-Effects-Interactions pattern).

### 4. Zero and Negative Amounts Rejection
All milestone amounts must be strictly positive:
$$\forall i, \text{milestone\_amount}_i > 0$$
Zero-amount and negative-amount milestones are explicitly rejected at creation time to prevent empty milestone execution paths and arithmetic underflow.
