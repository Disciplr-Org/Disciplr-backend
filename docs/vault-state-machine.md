# Vault State Machine

## States

| State       | Description                        |
| ----------- | ---------------------------------- |
| `draft`     | Initial state                      |
| `active`    | Vault is running                   |
| `completed` | Terminal - all milestones verified |
| `failed`    | Terminal - deadline passed         |
| `cancelled` | Terminal - creator cancelled       |

## Allowed Transitions

draft → active, cancelled
active → completed, failed, cancelled
completed → (none)
failed → (none)
cancelled → (none)

## Validation Rules

| Transition         | Requirement             | Error                             |
| ------------------ | ----------------------- | --------------------------------- |
| active → completed | All milestones verified | "not all milestones are verified" |
| active → failed    | endTimestamp passed     | "endTimestamp has not passed"     |
| active → cancelled | Creator only            | "only the creator can cancel"     |

## Invariants

- `completed`, `failed`, and `cancelled` are terminal states and may not transition further.
- `draft` may only transition to `active` or `cancelled`.
- `active` may only transition to `completed`, `failed`, or `cancelled`.
- `completed` is only permitted when the vault has at least one milestone and every milestone is verified.
- `failed` is only permitted when the vault's `endTimestamp` has passed.
- `cancelled` is only permitted when requested by the vault `creator`.
- `active` vaults with a past `endTimestamp` are automatically marked `failed` by the expiration checker.

## Property-based coverage

The repository includes randomized invariant coverage for the state machine in `src/tests/vaultTransitions.test.ts`.
