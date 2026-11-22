export class QueryValidationError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'QueryValidationError'
    this.status = 400
    if (details) this.details = details
  }
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/
const VAULT_ID_REGEX = /^vault-[a-z0-9-]{1,64}$/
const VALID_STATUSES = new Set(['active', 'completed', 'failed'])

/**
 * Validates the status query parameter.
 * status= (empty string) is treated as absent and returns undefined.
 * Valid values: 'active' | 'completed' | 'failed'.
 * Otherwise throws QueryValidationError (400).
 */
export function validateStatus(status) {
  if (status === undefined || status === null) return undefined
  if (Array.isArray(status)) {
    throw new QueryValidationError('Invalid status query parameter', ['status must not be an array'])
  }
  const str = String(status).trim()
  if (str === '') return undefined
  if (!VALID_STATUSES.has(str)) {
    throw new QueryValidationError('Invalid status query parameter', [`status must be one of: active, completed, failed (got "${str}")`])
  }
  return str
}

/**
 * Validates the creator query parameter.
 * Must be a valid Stellar public key StrKey (G-address, 56 chars).
 * Otherwise throws QueryValidationError (400).
 */
export function validateCreator(creator) {
  if (creator === undefined || creator === null) return undefined
  if (Array.isArray(creator)) {
    throw new QueryValidationError('Invalid creator query parameter', ['creator must not be an array'])
  }
  const str = String(creator).trim()
  if (str === '') return undefined
  if (!STELLAR_ADDRESS_REGEX.test(str)) {
    throw new QueryValidationError('Invalid creator query parameter', ['creator must be a valid Stellar public key (G..., 56 chars)'])
  }
  return str
}

/**
 * Validates the vaultId query parameter.
 * Pattern: ^vault-[a-z0-9-]{1,64}$
 * Otherwise throws QueryValidationError (400).
 */
export function validateVaultId(vaultId) {
  if (vaultId === undefined || vaultId === null) return undefined
  if (Array.isArray(vaultId)) {
    throw new QueryValidationError('Invalid vaultId query parameter', ['vaultId must not be an array'])
  }
  const str = String(vaultId).trim()
  if (str === '') return undefined
  if (!VAULT_ID_REGEX.test(str)) {
    throw new QueryValidationError('Invalid vaultId query parameter', ['vaultId must match ^vault-[a-z0-9-]{1,64}$'])
  }
  return str
}
