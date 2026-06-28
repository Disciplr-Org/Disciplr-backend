# Soroban Contract Error Catalog

The `accountability_vault` contract surfaces a series of numerical error codes when operations fail on-chain. These codes are mapped by the backend (`src/middleware/errorHandler.ts`) into standardized `AppError` API envelopes.

| Contract Code | Backend Error Code | HTTP Status | Meaning |
| :--- | :--- | :--- | :--- |
| **1** | `CONFLICT` | 409 | **AlreadyInitialized**: Vault has already been created and initialized. |
| **2** | `NOT_FOUND` | 404 | **NotInitialized**: Attempting to interact with an uninitialized vault. |
| **3** | `VALIDATION_ERROR` | 400 | **InvalidAmount**: The provided staking amount is <= 0 or invalid. |
| **4** | `VALIDATION_ERROR` | 400 | **InvalidDeadline**: The vault deadline must be in the future. |
| **5** | `VALIDATION_ERROR` | 400 | **NoMilestones**: Vault must have at least one milestone. |
| **6** | `CONFLICT` | 409 | **NotDraft**: Operation requires the vault to be in Draft status. |
| **7** | `CONFLICT` | 409 | **NotActive**: Operation requires the vault to be actively funded. |
| **8** | `UNAUTHORIZED` | 401 | **Unauthorized**: Caller lacks permission (e.g. not creator or verifier). |
| **9** | `CONFLICT` | 409 | **AlreadyStaked**: Vault has already been funded. |
| **10** | `VALIDATION_ERROR` | 400 | **MilestoneIndexOutOfRange**: Invalid milestone index referenced. |
| **11** | `CONFLICT` | 409 | **MilestoneAlreadyVerified**: This milestone was already confirmed. |
| **12** | `CONFLICT` | 409 | **DeadlinePassed**: Operation cannot be performed after the deadline. |
| **13** | `CONFLICT` | 409 | **DeadlineNotReached**: The deadline must pass before slashing. |
| **14** | `CONFLICT` | 409 | **MilestonesIncomplete**: Not all milestones were verified. |
| **15** | `CONFLICT` | 409 | **NothingToWithdraw**: There are no staked funds to refund. |
| **16** | `VALIDATION_ERROR` | 400 | **AmountMismatch**: Milestone amounts do not sum to the total stake. |

## Client Integration
When a transaction fails via the Soroban RPC due to a contract error, the `buildVaultCreationPayload` helper traps the error and returns it embedded in the response payload instead of throwing an HTTP 500 error. The client receives it within the `submission` object in the API response:

```json
{
  "vault": { ... },
  "onChain": {
    "mode": "submit",
    "submission": {
      "attempted": true,
      "status": "error",
      "error": {
        "code": "VALIDATION_ERROR",
        "message": "Invalid deadline",
        "details": {
          "contractErrorCode": 4
        }
      }
    }
  }
}
```

This allows clients to reliably parse predictable failure states and present helpful localized messaging to users instead of generic RPC timeout/revert strings.
