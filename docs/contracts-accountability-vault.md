# Contracts: Accountability Vault — vault_id correlation

This project expects on-chain vault records to include a `vault_id` field that
corresponds to the backend `PersistedVault.id` (a UUID). The on-chain contract
should accept a `vault_id` (Symbol `vault_id`) in `create_vault` and persist it
in the Vault struct so emitted events can be correlated with off-chain rows.

Requirements for the contract:
- Accept `vault_id` as the first argument to `create_vault` (string/symbol).
- Persist `vault_id` in the Vault struct and include it in emitted events.
- Ensure the backend-generated UUID format is preserved (backend uses `randomUUID()`).

Notes for backend developers:
- `src/services/soroban.ts` builds the call args expecting `vaultId` first.
- `src/services/eventParser.ts` validates that incoming events include a
  `vaultId`/`vault_id` string that matches UUID format.
