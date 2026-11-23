import { createRequire } from 'node:module'
import * as sorobanModule from '../soroban.mjs'

const isJest = Boolean(process.env.JEST_WORKER_ID)
const { describe, it } = isJest ? { describe: globalThis.describe, it: globalThis.it } : await import('node:test')
const expect = isJest ? globalThis.expect : (await import('expect')).default
const jestCompat = isJest ? (await import('@jest/globals')).jest : {
  fn: (impl = async () => {}) => {
    const queue = []
    const mock = (...args) => {
      mock.mock.calls.push(args)
      return queue.length ? queue.shift()() : impl(...args)
    }
    mock.mock = { calls: [] }
    mock.mockResolvedValueOnce = (value) => { queue.push(() => Promise.resolve(value)); return mock }
    return mock
  },
}
const { toStroops, createVaultArgs, stakeArgs, buildCreateVaultTx, verifySignedTx, submitAndWait, decodeContractError, OnchainError, buildInvocationArgs, expectedArgs, CONTRACT_ERRORS } = sorobanModule

const sdk = createRequire(import.meta.url)('@stellar/stellar-sdk')
const { Keypair, Account, Contract, TransactionBuilder, StrKey, scValToNative, xdr } = sdk

const PASS = 'Test SDF Network ; September 2015'
const creatorKp = Keypair.random()
const cfg = {
  networkPassphrase: PASS,
  contractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
  tokenId: StrKey.encodeContract(Buffer.alloc(32, 2)),
}
const creator = creatorKp.publicKey()
const vault = {
  id: 'vault-abc123', creator, verifier: Keypair.random().publicKey(),
  successDestination: creator, failureDestination: Keypair.random().publicKey(),
  amount: '1.5', endDate: '2030-01-01T00:00:00.000Z',
  milestones: [
    { title: 'one', amount: '1', dueDate: '2029-06-01T00:00:00.000Z' },
    { title: 'two', amount: '0.5', dueDate: '2029-12-01T00:00:00.000Z' },
  ],
}

const signedTx = (op, args, { contractId = cfg.contractId, signer = creatorKp, source = vault.creator, pass = PASS } = {}) => {
  const tx = new TransactionBuilder(new Account(source, '1'), { fee: '100', networkPassphrase: pass })
    .addOperation(new Contract(contractId).call(op, ...args)).setTimeout(300).build()
  tx.sign(signer)
  return tx.toXDR()
}

describe('toStroops', () => {
  it('converts exactly with BigInt', () => {
    expect(toStroops('1.5')).toBe(15_000_000n)
    expect(toStroops('0.0000001')).toBe(1n)
    expect(toStroops('999999999999.1234567')).toBe(9999999999991234567n)
  })
  it('rejects non-exact input', () => {
    expect(() => toStroops('0.12345678')).toThrow(OnchainError)
    expect(() => toStroops('1e-7')).toThrow(OnchainError)
    expect(() => toStroops('-1')).toThrow(OnchainError)
  })
})

describe('create_vault arg encoding', () => {
  it('encodes stroops i128, u64 seconds, verifier set, oracle None and milestone vec', () => {
    const a = createVaultArgs(vault, cfg.tokenId)
    expect(a).toHaveLength(10)
    expect(scValToNative(a[0])).toBe(vault.id)
    expect(a[1].switch().name).toBe('scvAddress')
    const set = scValToNative(a[2])
    expect(set.threshold).toBe(1)
    expect(set.verifiers).toEqual([vault.verifier])
    expect(a[3].switch().name).toBe('scvVoid')
    expect(a[5].switch().name).toBe('scvI128')
    expect(scValToNative(a[5])).toBe(15_000_000n)
    expect(a[8].switch().name).toBe('scvU64')
    expect(scValToNative(a[8])).toBe(BigInt(Date.parse(vault.endDate) / 1000))
    const ms = scValToNative(a[9])
    expect(ms.map((m) => m.amount)).toEqual([10_000_000n, 5_000_000n])
    expect(ms[0]).toMatchObject({ title: 'one', verified: false, released: false, due_date: BigInt(Date.parse(vault.milestones[0].dueDate) / 1000) })
  })
  it('rejects milestones that do not sum to the vault amount', () => {
    expect(() => createVaultArgs({ ...vault, amount: '2' }, cfg.tokenId)).toThrow(/add up/)
  })
  it('builds an unsigned tx through the (mocked) rpc server', async () => {
    const server = { getAccount: jestCompat.fn(async (k) => new Account(k, '1')), prepareTransaction: jestCompat.fn(async (t) => t) }
    const out = await buildCreateVaultTx(server, cfg, vault)
    expect(out.networkPassphrase).toBe(PASS)
    const tx = TransactionBuilder.fromXDR(out.xdr, PASS)
    expect(tx.operations[0].func.invokeContract().functionName().toString()).toBe('create_vault')
  })
  it('maps simulation contract errors to a 400', async () => {
    const server = { getAccount: async (k) => new Account(k, '1'), prepareTransaction: async () => { throw new Error('HostError: Error(Contract, #16)') } }
    await expect(buildCreateVaultTx(server, cfg, vault)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('AmountMismatch') })
  })
})

describe('buildInvocationArgs', () => {
  const caller = Keypair.random().publicKey()
  it('encodes slash_on_miss with exactly one string ScVal', () => {
    const a = buildInvocationArgs('slash_on_miss', { vaultId: vault.id })
    expect(a).toHaveLength(1)
    expect(a[0].switch().name).toBe('scvString')
    expect(scValToNative(a[0])).toBe(vault.id)
  })
  it('encodes claim with vaultId and caller address', () => {
    const a = buildInvocationArgs('claim', { vaultId: vault.id, caller })
    expect(a).toHaveLength(2)
    expect(scValToNative(a[0])).toBe(vault.id)
    expect(a[1].switch().name).toBe('scvAddress')
    expect(scValToNative(a[1])).toBe(caller)
  })
  it('encodes claim_milestone with vaultId, caller and u32 index', () => {
    const a = buildInvocationArgs('claim_milestone', { vaultId: vault.id, caller, index: 1 })
    expect(a).toHaveLength(3)
    expect(scValToNative(a[0])).toBe(vault.id)
    expect(a[1].switch().name).toBe('scvAddress')
    expect(scValToNative(a[1])).toBe(caller)
    expect(a[2].switch().name).toBe('scvU32')
    expect(scValToNative(a[2])).toBe(1)
  })
  it('encodes withdraw with vaultId and creator address', () => {
    const a = buildInvocationArgs('withdraw', { vaultId: vault.id, creator })
    expect(a).toHaveLength(2)
    expect(scValToNative(a[0])).toBe(vault.id)
    expect(a[1].switch().name).toBe('scvAddress')
    expect(scValToNative(a[1])).toBe(creator)
  })
  it('rejects an invalid G-address before any RPC call', () => {
    expect(() => buildInvocationArgs('claim', { vaultId: vault.id, caller: 'not-an-address' })).toThrow(OnchainError)
    expect(() => buildInvocationArgs('withdraw', { vaultId: vault.id, creator: 'GINVALID' })).toThrow(OnchainError)
  })
  it('rejects muxed addresses', () => {
    const muxed = 'MAAAAAAAAAAAAAB7BQ2L7E5NBWMXDUCMZSIPOBKRDSBYI7LWNQB2W5O46CXQH5ZQ5Q5Q5Q'
    expect(() => buildInvocationArgs('claim', { vaultId: vault.id, caller: muxed })).toThrow(OnchainError)
  })
  it('builds a Contract.call with the right function name and arg count', () => {
    const tx = new TransactionBuilder(new Account(creator, '1'), { fee: '100', networkPassphrase: PASS })
      .addOperation(new Contract(cfg.contractId).call('withdraw', ...buildInvocationArgs('withdraw', { vaultId: vault.id, creator })))
      .setTimeout(300).build()
    const op = TransactionBuilder.fromXDR(tx.toXDR(), PASS).operations[0]
    const inv = op.func.invokeContract()
    expect(inv.functionName().toString()).toBe('withdraw')
    expect(inv.args()).toHaveLength(2)
  })
})

describe('invocation building and signing model', () => {
  const mockServer = () => ({ getAccount: jestCompat.fn(async (k) => new Account(k, '1')), prepareTransaction: jestCompat.fn(async (t) => t) })

  it('builds an unsigned withdraw invocation through buildInvocationArgs', async () => {
    const server = mockServer()
    const args = buildInvocationArgs('withdraw', { vaultId: vault.id, creator })
    const tx = new TransactionBuilder(new Account(creator, '1'), { fee: '100', networkPassphrase: PASS })
      .addOperation(new Contract(cfg.contractId).call('withdraw', ...args)).setTimeout(300).build()
    const prepared = await server.prepareTransaction(tx)
    const decoded = TransactionBuilder.fromXDR(prepared.toXDR(), PASS)
    expect(decoded.operations).toHaveLength(1)
    const inv = decoded.operations[0].func.invokeContract()
    expect(inv.functionName().toString()).toBe('withdraw')
    expect(inv.args()).toHaveLength(2)
    expect(decoded.signatures).toHaveLength(0)
    expect(server.prepareTransaction.mock.calls).toHaveLength(1)
  })

  it('expectedArgs matches the create_vault and stake encoders', () => {
    const encode = (args) => args.map((a) => a.toXDR('base64'))
    expect(encode(expectedArgs('create_vault', vault, cfg))).toEqual(encode(createVaultArgs(vault, cfg.tokenId)))
    expect(encode(expectedArgs('stake', vault, cfg))).toEqual(encode(stakeArgs(vault)))
  })

  it('buildCreateVaultTx never signs with a backend key', async () => {
    const server = mockServer()
    const out = await buildCreateVaultTx(server, cfg, vault)
    const tx = TransactionBuilder.fromXDR(out.xdr, PASS)
    expect(tx.signatures).toHaveLength(0)
    expect(server.prepareTransaction.mock.calls).toHaveLength(1)
  })

  it('maps contract errors such as #13 to named errors', async () => {
    const server = { getAccount: async (k) => new Account(k, '1'), prepareTransaction: async () => { throw new Error('HostError: Error(Contract, #13)') } }
    await expect(buildCreateVaultTx(server, cfg, vault)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('DeadlineNotReached') })
  })
})

describe('verifySignedTx', () => {
  const good = () => signedTx('create_vault', createVaultArgs(vault, cfg.tokenId))
  it('accepts the exact invocation and returns its hash', () => {
    const { hash } = verifySignedTx(good(), vault, 'create_vault', cfg)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('accepts stake', () => {
    expect(() => verifySignedTx(signedTx('stake', stakeArgs(vault)), vault, 'stake', cfg)).not.toThrow()
  })
  it('rejects a different contract', () => {
    const x = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { contractId: StrKey.encodeContract(Buffer.alloc(32, 9)) })
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/different contract/)
  })
  it('rejects a different function', () => {
    expect(() => verifySignedTx(signedTx('stake', stakeArgs(vault)), vault, 'create_vault', cfg)).toThrow(/must call create_vault/)
  })
  it('rejects different args', () => {
    const x = signedTx('create_vault', createVaultArgs({ ...vault, id: 'vault-other' }, cfg.tokenId))
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/do not match/)
  })
  it('rejects a foreign source or signer', () => {
    const other = Keypair.random()
    const x = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { signer: other, source: other.publicKey() })
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/source must be the vault creator/)
    const y = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { signer: other })
    expect(() => verifySignedTx(y, vault, 'create_vault', cfg)).toThrow(/signature/)
  })
  it('rejects a network passphrase mismatch', () => {
    const x = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { pass: 'Public Global Stellar Network ; September 2015' })
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/signature/)
  })
  it('rejects garbage', () => {
    expect(() => verifySignedTx('not-xdr', vault, 'create_vault', cfg)).toThrow(OnchainError)
  })
})

describe('result decoding and polling', () => {
  const errEvent = (code) => ({
    event: () => ({ body: () => ({ v0: () => ({ topics: () => [xdr.ScVal.scvSymbol('error')], data: () => xdr.ScVal.scvError(xdr.ScError.sceContract(code)) }) }) }),
  })
  it('decodes the contract error name from diagnostic events', () => {
    expect(decodeContractError([errEvent(16)])).toMatchObject({ code: 16, name: 'AmountMismatch' })
    expect(decodeContractError([])).toBeNull()
  })
  it('decodes a known CONTRACT_ERRORS code from a simulation message', () => {
    expect(decodeContractError('HostError: Error(Contract, #13)')).toMatchObject({ code: 13, name: CONTRACT_ERRORS[13][0] })
  })

  const tx = { id: 'tx' }
  const hash = 'ab'.repeat(32)
  it('returns SUCCESS with the ledger', async () => {
    const server = { sendTransaction: jestCompat.fn(async () => ({ status: 'PENDING', hash })), getTransaction: jestCompat.fn().mockResolvedValueOnce({ status: 'NOT_FOUND' }).mockResolvedValueOnce({ status: 'SUCCESS', ledger: 777 }) }
    await expect(submitAndWait(server, tx, hash, { intervalMs: 1 })).resolves.toEqual({ status: 'SUCCESS', hash, ledger: 777 })
  })
  it('returns FAILED with the decoded error name', async () => {
    const server = { sendTransaction: async () => ({ status: 'PENDING', hash }), getTransaction: async () => ({ status: 'FAILED', ledger: 5, diagnosticEventsXdr: [errEvent(16)] }) }
    const r = await submitAndWait(server, tx, hash, { intervalMs: 1 })
    expect(r.status).toBe('FAILED')
    expect(r.error.name).toBe('AmountMismatch')
  })
  it('stays PENDING when polling times out', async () => {
    const server = { sendTransaction: async () => ({ status: 'PENDING', hash }), getTransaction: async () => ({ status: 'NOT_FOUND' }) }
    await expect(submitAndWait(server, tx, hash, { timeoutMs: 20, intervalMs: 5 })).resolves.toEqual({ status: 'PENDING', hash })
  })
  it('resume checks the chain first and does not re-broadcast', async () => {
    const server = { sendTransaction: jestCompat.fn(), getTransaction: async () => ({ status: 'SUCCESS', ledger: 9 }) }
    const r = await submitAndWait(server, tx, hash, { resume: true })
    expect(r.status).toBe('SUCCESS')
    expect(server.sendTransaction.mock.calls).toHaveLength(0)
  })
  it('tolerates RPC errors while polling', async () => {
    const server = { sendTransaction: async () => ({ status: 'PENDING', hash }), getTransaction: async () => { throw new Error('rpc down') } }
    await expect(submitAndWait(server, tx, hash, { timeoutMs: 20, intervalMs: 5 })).resolves.toMatchObject({ status: 'PENDING' })
  })
})
