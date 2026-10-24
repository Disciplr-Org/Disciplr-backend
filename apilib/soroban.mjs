// Soroban integration for the deployed API: builds unsigned create_vault / stake invocations for the
// creator's wallet to sign, verifies the signed XDR against the stored vault, relays it and polls the result.
// The server never holds a user key; it only builds and relays.
import { createRequire } from 'node:module'

const sdk = createRequire(import.meta.url)('@stellar/stellar-sdk')
const { rpc, Contract, TransactionBuilder, Address, Keypair, nativeToScVal, xdr, BASE_FEE } = sdk

export class OnchainError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message)
    this.status = status
    Object.assign(this, extra)
  }
}

// Contract `Error` enum (contracts/accountability_vault/src/lib.rs) -> readable messages.
export const CONTRACT_ERRORS = {
  1: ['AlreadyInitialized', 'A vault with this id already exists on-chain'],
  2: ['NotInitialized', 'No vault with this id exists on-chain'],
  3: ['InvalidAmount', 'Amount must be greater than zero'],
  4: ['InvalidDeadline', 'Deadline is in the past, after the vault end, or beyond the 5-year horizon'],
  5: ['NoMilestones', 'At least one milestone is required'],
  6: ['NotDraft', 'Vault is not in draft state'],
  7: ['NotActive', 'Vault is not active'],
  8: ['Unauthorized', 'Caller is not permitted for this operation'],
  9: ['AlreadyStaked', 'Vault has already been funded'],
  10: ['MilestoneIndexOutOfRange', 'Milestone index is out of range'],
  11: ['MilestoneAlreadyVerified', 'Milestone is already verified'],
  12: ['DeadlinePassed', 'The deadline has passed'],
  13: ['DeadlineNotReached', 'The deadline has not been reached yet'],
  14: ['MilestonesIncomplete', 'Not all milestones are verified'],
  15: ['NothingToWithdraw', 'Nothing to withdraw'],
  16: ['AmountMismatch', 'Milestone amounts must add up to the vault amount (or the received stake was too low)'],
  17: ['InsufficientAllowance', 'Token allowance is too low'],
  18: ['Paused', 'Vault is paused'],
  19: ['AlreadyApproved', 'Caller has already approved this milestone'],
  20: ['NoVerifiers', 'At least one verifier is required'],
  21: ['InvalidThreshold', 'Approval threshold must be between 1 and the number of verifiers'],
  22: ['StakedRemaining', 'Vault still has staked funds'],
  23: ['NotCreator', 'Caller is not the vault creator'],
  24: ['NotVerifier', 'Caller is not a verifier'],
  25: ['NotCreatorOrVerifier', 'Caller is neither the creator nor a verifier'],
  26: ['InvalidFailureDestination', 'Failure destination must differ from the creator'],
  27: ['VaultDisputed', 'Vault is disputed'],
  28: ['PartiallyReleased', 'Bulk claim is not allowed after an individual claim'],
  29: ['MilestoneAlreadyReleased', 'Milestone has already been released'],
  30: ['TitleTooLong', 'Milestone title exceeds 128 bytes'],
}

export const isEnabled = (env = process.env) => env.SOROBAN_ENABLED === '1'

export function getConfig(env = process.env) {
  const cfg = {
    rpcUrl: env.SOROBAN_RPC_URL, networkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE,
    contractId: env.VAULT_CONTRACT_ID, tokenId: env.VAULT_TOKEN_ID,
  }
  const missing = [['SOROBAN_RPC_URL', cfg.rpcUrl], ['SOROBAN_NETWORK_PASSPHRASE', cfg.networkPassphrase],
    ['VAULT_CONTRACT_ID', cfg.contractId], ['VAULT_TOKEN_ID', cfg.tokenId]].filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new OnchainError(`Soroban is enabled but not configured: ${missing.join(', ')}`, 503)
  return cfg
}

let serverOverride
/** Test hook: inject a stand-in for rpc.Server. Pass undefined to reset. */
export function setServerForTests(s) { serverOverride = s }
export function getServer(cfg) {
  return serverOverride || new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') })
}

/** Exact decimal -> stroops (7 decimals) as BigInt; never goes through floating point arithmetic. */
export function toStroops(value) {
  const s = String(value).trim()
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new OnchainError(`Invalid amount "${s}": use a plain decimal with at most 7 decimal places`)
  const [whole, frac = ''] = s.split('.')
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, '0'))
}

const seconds = (iso) => BigInt(Math.floor(new Date(iso).getTime() / 1000))
const sym = (k) => xdr.ScVal.scvSymbol(k)
const addr = (a) => new Address(a).toScVal()
const entry = (k, v) => new xdr.ScMapEntry({ key: sym(k), val: v })

/** Check chain-level constraints the contract enforces, so we fail before building anything. */
export function validateForChain(vault) {
  const amount = toStroops(vault.amount)
  let sum = 0n
  for (const m of vault.milestones) {
    const a = toStroops(m.amount)
    if (a <= 0n) throw new OnchainError('Every milestone amount must be greater than zero on-chain')
    if (seconds(m.dueDate) > seconds(vault.endDate)) throw new OnchainError('Milestone dueDate must not be after endDate')
    if (Buffer.byteLength(m.title) > 128) throw new OnchainError('Milestone title exceeds 128 bytes')
    sum += a
  }
  if (sum !== amount) throw new OnchainError('Milestone amounts must add up exactly to the vault amount')
  if (vault.failureDestination === vault.creator) throw new OnchainError('failureDestination must differ from the creator')
  return amount
}

/** ScVal args for create_vault, in contract order. Struct maps are keyed by symbol in sorted order. */
export function createVaultArgs(vault, tokenId) {
  const amount = validateForChain(vault)
  const milestones = vault.milestones.map((m) => xdr.ScVal.scvMap([
    entry('amount', nativeToScVal(toStroops(m.amount), { type: 'i128' })),
    entry('due_date', nativeToScVal(seconds(m.dueDate), { type: 'u64' })),
    entry('released', xdr.ScVal.scvBool(false)),
    entry('title', nativeToScVal(m.title, { type: 'string' })),
    entry('verified', xdr.ScVal.scvBool(false)),
  ]))
  return [
    nativeToScVal(vault.id, { type: 'string' }),
    addr(vault.creator),
    xdr.ScVal.scvMap([entry('threshold', nativeToScVal(1, { type: 'u32' })), entry('verifiers', xdr.ScVal.scvVec([addr(vault.verifier)]))]),
    xdr.ScVal.scvVoid(), // oracle: None
    addr(tokenId),
    nativeToScVal(amount, { type: 'i128' }),
    addr(vault.successDestination),
    addr(vault.failureDestination),
    nativeToScVal(seconds(vault.endDate), { type: 'u64' }),
    xdr.ScVal.scvVec(milestones),
  ]
}

export const stakeArgs = (vault) => [nativeToScVal(vault.id, { type: 'string' }), addr(vault.creator)]

/**
 * Typed argument shapes for the settlement invocations. These mirror the accountability_vault ABI:
 *   slash_on_miss(vault_id: String)
 *   claim(vault_id: String, caller: Address)
 *   claim_milestone(vault_id: String, caller: Address, index: u32)
 *   withdraw(vault_id: String, creator: Address)
 */
export const SLASH_ARGS = ['vaultId']
export const CLAIM_ARGS = ['vaultId', 'caller']
export const CLAIM_MILESTONE_ARGS = ['vaultId', 'caller', 'index']
export const WITHDRAW_ARGS = ['vaultId', 'creator']

const ARG_SHAPES = {
  slash_on_miss: SLASH_ARGS,
  claim: CLAIM_ARGS,
  claim_milestone: CLAIM_MILESTONE_ARGS,
  withdraw: WITHDRAW_ARGS,
}

/** Reject anything that is not a plain G-address (muxed M-addresses are not accepted). */
export function assertGAddress(value, field) {
  if (typeof value !== 'string' || !/^G[A-Z2-7]{55}$/.test(value)) {
    throw new OnchainError(`${field} must be a valid Stellar G-address`, 400, { field })
  }
  try { Keypair.fromPublicKey(value) } catch { throw new OnchainError(`${field} must be a valid Stellar G-address`, 400, { field }) }
  return value
}

/**
 * Pure ScVal encoder for the settlement invocations. No RPC, so it is unit-testable in isolation.
 * Returns the args in contract order.
 */
export function buildInvocationArgs(method, args = {}) {
  const shape = ARG_SHAPES[method]
  if (!shape) throw new OnchainError(`Unsupported method ${method}`)
  const extra = Object.keys(args).filter((k) => !shape.includes(k))
  if (extra.length) throw new OnchainError(`Unexpected argument(s) for ${method}: ${extra.join(', ')}`)
  const missing = shape.filter((k) => args[k] === undefined || args[k] === null)
  if (missing.length) throw new OnchainError(`Missing argument(s) for ${method}: ${missing.join(', ')}`)
  return shape.map((k) => {
    if (k === 'vaultId') return nativeToScVal(String(args.vaultId), { type: 'string' })
    if (k === 'caller' || k === 'creator') return addr(assertGAddress(args[k], k))
    if (k === 'index') {
      const n = Number(args.index)
      if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new OnchainError('index must be a u32', 400, { field: 'index' })
      return nativeToScVal(n, { type: 'u32' })
    }
    throw new OnchainError(`Unsupported argument ${k}`)
  })
}

export function expectedArgs(operation, vault, cfg) {
  if (operation === 'create_vault') return createVaultArgs(vault, cfg.tokenId)
  if (operation === 'stake') return stakeArgs(vault)
  throw new OnchainError(`Unsupported operation ${operation}`)
}

/** Pull the contract error code out of a simulation/transaction error string or diagnostic events. */
export function decodeContractError(input) {
  let code
  if (typeof input === 'string') {
    const m = /Error\(Contract, #(\d+)\)/.exec(input)
    if (m) code = Number(m[1])
  } else {
    for (const ev of input || []) {
      try {
        const e = typeof ev === 'string' ? xdr.DiagnosticEvent.fromXDR(ev, 'base64') : ev
        const v0 = e.event().body().v0()
        for (const v of [...v0.topics(), v0.data()]) {
          if (v.switch().name === 'scvError' && v.error().switch().name === 'sceContract') { code = v.error().contractCode(); break }
        }
      } catch { /* not a decodable event */ }
      if (code !== undefined) break
    }
  }
  if (code === undefined) return null
  const [name, message] = CONTRACT_ERRORS[code] || [`Error#${code}`, 'Unknown contract error']
  return { code, name, message }
}

async function buildUnsigned(server, cfg, vault, operation) {
  const account = await server.getAccount(vault.creator)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(new Contract(cfg.contractId).call(operation, ...expectedArgs(operation, vault, cfg)))
    .setTimeout(300).build()
  try {
    const prepared = await server.prepareTransaction(tx) // simulate + footprint + resource fee
    return { xdr: prepared.toXDR(), networkPassphrase: cfg.networkPassphrase, operation }
  } catch (e) {
    const d = decodeContractError(String(e?.message || e))
    if (d) throw new OnchainError(`${d.name}: ${d.message}`, 400, { contractError: d })
    throw new OnchainError(`Soroban simulation failed: ${String(e?.message || e).slice(0, 300)}`, 502)
  }
}

export const buildCreateVaultTx = (server, cfg, vault) => buildUnsigned(server, cfg, vault, 'create_vault')
export const buildStakeTx = (server, cfg, vault) => buildUnsigned(server, cfg, vault, 'stake')

/**
 * Decode a client-signed XDR and prove it is exactly the expected invocation for this vault:
 * same network, source = creator, signed by the creator, one invoke-contract op on the configured
 * contract and function with args identical to those we would have built. Throws OnchainError(400).
 */
export function verifySignedTx(signedXdr, vault, operation, cfg) {
  let tx
  try { tx = TransactionBuilder.fromXDR(String(signedXdr), cfg.networkPassphrase) } catch { throw new OnchainError('signedXdr is not a valid transaction envelope') }
  if (tx.innerTransaction) throw new OnchainError('Fee-bump transactions are not accepted')
  if (tx.source !== vault.creator) throw new OnchainError('Transaction source must be the vault creator')
  let signed = false
  try {
    const kp = Keypair.fromPublicKey(vault.creator); const h = tx.hash()
    signed = tx.signatures.some((s) => kp.verify(h, s.signature()))
  } catch { signed = false }
  if (!signed) throw new OnchainError('No valid creator signature for this network passphrase')
  if (tx.operations.length !== 1) throw new OnchainError('Transaction must contain exactly one operation')
  const op = tx.operations[0]
  if (op.type !== 'invokeHostFunction' || op.func.switch().name !== 'hostFunctionTypeInvokeContract') throw new OnchainError('Transaction must invoke a contract')
  if (op.source && op.source !== vault.creator) throw new OnchainError('Operation source must be the vault creator')
  const inv = op.func.invokeContract()
  if (Address.fromScAddress(inv.contractAddress()).toString() !== cfg.contractId) throw new OnchainError('Transaction targets a different contract')
  if (inv.functionName().toString() !== operation) throw new OnchainError(`Transaction must call ${operation}`)
  const want = expectedArgs(operation, vault, cfg).map((a) => a.toXDR('base64'))
  const got = inv.args().map((a) => a.toXDR('base64'))
  if (want.length !== got.length || want.some((w, i) => w !== got[i])) throw new OnchainError(`Transaction arguments do not match vault ${vault.id}`)
  return { tx, hash: tx.hash().toString('hex') }
}

/** Transaction hash of an envelope under the configured network, or null if it does not parse. */
export function txHashOf(signedXdr, cfg) {
  try { return TransactionBuilder.fromXDR(String(signedXdr), cfg.networkPassphrase).hash().toString('hex') } catch { return null }
}

const sleep =(ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Broadcast (unless `resume`) and poll until SUCCESS/FAILED or the time budget is spent.
 * Resolves { status: 'SUCCESS'|'FAILED'|'PENDING', hash, ledger?, error? }; a timeout is PENDING, never success.
 */
export async function submitAndWait(server, tx, hash, { resume = false, timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const fetchTx = async () => { try { return await server.getTransaction(hash) } catch { return null } }
  let res = resume ? await fetchTx() : null
  if (!res || res.status === 'NOT_FOUND') {
    const sent = await server.sendTransaction(tx)
    if (sent.status === 'ERROR') throw new OnchainError('Network rejected the transaction', 400, { detail: String(sent.errorResult?.result?.()?.switch?.()?.name || 'unknown') })
    if (sent.status === 'TRY_AGAIN_LATER') return { status: 'PENDING', hash }
    res = null
  }
  const deadline = Date.now() + timeoutMs
  while (!res || res.status === 'NOT_FOUND') {
    if (Date.now() >= deadline) return { status: 'PENDING', hash }
    await sleep(intervalMs)
    res = await fetchTx()
  }
  if (res.status === 'SUCCESS') return { status: 'SUCCESS', hash, ledger: res.ledger }
  const d = decodeContractError(res.diagnosticEventsXdr)
  return { status: 'FAILED', hash, ledger: res.ledger, error: d || { name: 'TransactionFailed', message: 'Transaction failed on-chain' } }
}
