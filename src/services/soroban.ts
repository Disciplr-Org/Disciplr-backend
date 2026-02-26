import type { CreateVaultInput, PersistedVault, VaultCreateResponse } from '../types/vaults.js'

const DEFAULT_CONTRACT_ID = 'CONTRACT_ID_NOT_CONFIGURED'
const DEFAULT_SOURCE_ACCOUNT = 'SOURCE_ACCOUNT_NOT_CONFIGURED'

export const buildVaultCreationPayload = (
  input: CreateVaultInput,
  vault: PersistedVault,
): VaultCreateResponse['onChain'] => {
  const mode = input.onChain?.mode ?? 'build'

  return {
    mode,
    payload: {
      contractId: input.onChain?.contractId ?? process.env.SOROBAN_CONTRACT_ID ?? DEFAULT_CONTRACT_ID,
      networkPassphrase: input.onChain?.networkPassphrase ?? process.env.SOROBAN_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
      sourceAccount: input.onChain?.sourceAccount ?? process.env.SOROBAN_SOURCE_ACCOUNT ?? DEFAULT_SOURCE_ACCOUNT,
      method: 'create_vault',
      args: {
        vaultId: vault.id,
        amount: vault.amount,
        verifier: vault.verifier,
        successDestination: vault.successDestination,
        failureDestination: vault.failureDestination,
        milestones: vault.milestones.map((milestone) => ({
          id: milestone.id,
          title: milestone.title,
          amount: milestone.amount,
          dueDate: milestone.dueDate,
        })),
      },
    },
    submission: {
      attempted: mode === 'submit',
      status: mode === 'submit' ? 'not_configured' : 'not_requested',
    },
  }
}
