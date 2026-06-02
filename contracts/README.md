# Disciplr Contracts

This directory is reserved for on-chain contract artefacts (e.g. Soroban / Rust source for `accountability_vault`). The section below is the **authoritative schema** for every event topic emitted by `accountability_vault` so that the off-chain backend can be reviewed against it.

## Event Schema — `accountability_vault`

All events are emitted via `env.events().publish()`. The first topic element is always the event name (a `Symbol`). Subsequent topic elements and the data value are described per event below.

> Backend parser: [`src/services/eventParser.ts`](../src/services/eventParser.ts)  
> EventType union: [`src/types/horizonSync.ts`](../src/types/horizonSync.ts)

### Topic reference

| Topic (1st element) | Emitting function | Payload type | Required payload fields | Backend `EventType` |
|---|---|---|---|---|
| `vault_created` | `create_vault` | `VaultEventPayload` | `vaultId`, `creator` (Stellar address), `amount` (decimal string, 7 d.p.), `startTimestamp`, `endTimestamp`, `successDestination`, `failureDestination`, `status: "active"` | ✅ `vault_created` |
| `vault_completed` | `complete_vault` | `VaultEventPayload` | `vaultId`, `status: "completed"` | ✅ `vault_completed` |
| `vault_failed` | `fail_vault` | `VaultEventPayload` | `vaultId`, `status: "failed"` | ✅ `vault_failed` |
| `vault_cancelled` | `cancel_vault` | `VaultEventPayload` | `vaultId`, `status: "cancelled"` | ✅ `vault_cancelled` |
| `milestone_created` | `add_milestone` | `MilestoneEventPayload` | `milestoneId`, `vaultId`, `title` (≤255 chars), `description` (≤1000 chars), `targetAmount`, `deadline` | ✅ `milestone_created` |
| `milestone_validated` | `validate_milestone` | `ValidationEventPayload` | `validationId`, `milestoneId`, `validatorAddress`, `validationResult` (`approved`\|`rejected`\|`pending_review`), `evidenceHash`, `validatedAt` | ✅ `milestone_validated` |
| `vault_staked` | `stake` | _(not yet parsed)_ | `vaultId`, `staker` (Stellar address), `amount` | ❌ not in `EventType` |
| `vault_slashed` | `slash` | _(not yet parsed)_ | `vaultId`, `amount`, `reason` | ❌ not in `EventType` |
| `vault_withdrawn` | `withdraw` | _(not yet parsed)_ | `vaultId`, `recipient`, `amount` | ❌ not in `EventType` |
| `milestone_checked_in` | `check_in` | _(not yet parsed)_ | `milestoneId`, `vaultId`, `checkedInAt` | ❌ not in `EventType` |

> **Note:** `vault_staked`, `vault_slashed`, `vault_withdrawn`, and `milestone_checked_in` are emitted by the contract but are **not yet handled** by the backend event parser. They will produce an `"Unknown event type"` error when received. Add them to `EventType` in `src/types/horizonSync.ts` and implement parsers in `src/services/eventParser.ts` when ready.

### Payload field details

#### `VaultEventPayload`

| Field | Type | Required for | Constraints |
|---|---|---|---|
| `vaultId` | `string` | all vault events | non-empty |
| `creator` | `string` | `vault_created` | Stellar address (`G[A-Z0-9]{55}`) |
| `amount` | `string` | `vault_created` | positive decimal, up to 7 d.p. |
| `startTimestamp` | `Date` (ISO-8601 string on-wire) | `vault_created` | valid date |
| `endTimestamp` | `Date` | `vault_created` | valid date, must be after `startTimestamp` |
| `successDestination` | `string` | `vault_created` | Stellar address |
| `failureDestination` | `string` | `vault_created` | Stellar address |
| `status` | `"active"\|"completed"\|"failed"\|"cancelled"` | all vault events | fixed per event |

#### `MilestoneEventPayload`

| Field | Type | Constraints |
|---|---|---|
| `milestoneId` | `string` | non-empty |
| `vaultId` | `string` | non-empty |
| `title` | `string` | 1–255 chars |
| `description` | `string` | 0–1000 chars |
| `targetAmount` | `string` | positive decimal, up to 7 d.p. |
| `deadline` | `Date` | valid future date |

#### `ValidationEventPayload`

| Field | Type | Constraints |
|---|---|---|
| `validationId` | `string` | non-empty |
| `milestoneId` | `string` | non-empty |
| `validatorAddress` | `string` | Stellar address |
| `validationResult` | `"approved"\|"rejected"\|"pending_review"` | one of listed values |
| `evidenceHash` | `string` | alphanumeric, `_`, `-` |
| `validatedAt` | `Date` | valid date |

### Wire format

Events are encoded as Stellar XDR (`ScVal`). The backend decodes them via `@stellar/stellar-sdk` `scValToNative`, then falls back to JSON (used in tests and fixtures). Snake_case aliases (e.g. `vault_id` → `vaultId`) are normalised by the parser.

### Versioning

This schema is at **v1**. Any addition of new fields or topics must be reflected here, in `src/types/horizonSync.ts`, and in `src/services/eventParser.ts` **before** deploying the contract upgrade.
