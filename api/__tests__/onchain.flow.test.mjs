import { jest } from '@jest/globals'
import { createRequire } from 'node:module'
import request from 'supertest'
import { createApp } from '../index.mjs'
import { MemoryStore } from '../../apilib/store.mjs'
import { setServerForTests } from '../../apilib/soroban.mjs'
import { resetMemoryBuckets } from '../../apilib/rateLimit.mjs'

const sdk = createRequire(import.meta.url)('@stellar/stellar-sdk')
const { Keypair, Account, TransactionBuilder, StrKey, xdr } = sdk

const PASS = 'Test SDF Network ; September 2015'
const creatorKp = Keypair.random()
const verifierKp = Keypair.random()
const body = () => ({
  name: 'Onchain', creator: creatorKp.publicKey(), verifier: verifierKp.publicKey(), amount: 100,
  endDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  milestones: [{ title: 'a', amount: 60 }, { title: 'b', amount: 40 }],
})
const sign = (x, kp = creatorKp) => { const t = TransactionBuilder.fromXDR(x, PASS); t.sign(kp); return { signedXdr: t.toXDR(), hash: t.hash().toString('hex') } }
const errEvent = (code) => ({ event: () => ({ body: () => ({ v0: () => ({ topics: () => [], data: () => xdr.ScVal.scvError(xdr.ScError.sceContract(code)) }) }) }) })

// The default store provider targets Postgres when DATABASE_URL is set (jest.setup.cjs sets one),
// so exercise the routes against an explicit in-memory store.
let memory
let app
let server
beforeEach(() => {
  resetMemoryBuckets()
  memory = new MemoryStore()
  app = createApp(async () => memory)
  process.env.SOROBAN_ENABLED = '1'
  process.env.SOROBAN_NETWORK_PASSPHRASE = PASS
  process.env.SOROBAN_RPC_URL = 'https://rpc.invalid'
  process.env.VAULT_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1))
  process.env.VAULT_TOKEN_ID = StrKey.encodeContract(Buffer.alloc(32, 2))
  process.env.SOROBAN_POLL_TIMEOUT_MS = '30'
  process.env.SOROBAN_POLL_INTERVAL_MS = '5'
  server = {
    getAccount: async (k) => new Account(k, '1'),
    prepareTransaction: async (t) => t,
    sendTransaction: jest.fn(async (t) => ({ status: 'PENDING', hash: t.hash().toString('hex') })),
    getTransaction: jest.fn(async () => ({ status: 'SUCCESS', ledger: 4242 })),
  }
  setServerForTests(server)
})
afterAll(() => { setServerForTests(undefined); delete process.env.SOROBAN_ENABLED })

describe('on-chain flow', () => {
  const createAndStake = async () => {
    const c = await request(app).post('/api/v1/vaults').send(body())
    const id = c.body.data.id
    await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: sign(c.body.onChain.xdr).signedXdr })
    const st = await request(app).post(`/api/v1/vaults/${id}/onchain/stake`).send({})
    const r2 = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: sign(st.body.onChain.xdr).signedXdr })
    return r2.body.data
  }

  it('create -> sign -> submit -> stake -> submit, with real hash and ledger', async () => {
    const c = await request(app).post('/api/v1/vaults').send(body())
    expect(c.status).toBe(201)
    expect(c.body.data.status).toBe('draft')
    expect(c.body.data.onchainStatus).toBe('pending_onchain')
    expect(c.body.onChain.networkPassphrase).toBe(PASS)
    const id = c.body.data.id

    const s1 = sign(c.body.onChain.xdr)
    const r1 = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: s1.signedXdr })
    expect(r1.status).toBe(200)
    expect(r1.body.activity).toMatchObject({ hash: s1.hash, ledger: 4242, status: 'confirmed', type: 'create' })
    expect(r1.body.data).toMatchObject({ status: 'draft', onchainStatus: 'created' })

    // Resubmitting the same signed XDR is idempotent: same hash, no second broadcast, no duplicate row.
    const again = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: s1.signedXdr })
    expect(again.status).toBe(200)
    expect(again.body.activity.hash).toBe(s1.hash)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)

    const st = await request(app).post(`/api/v1/vaults/${id}/onchain/stake`).send({})
    expect(st.status).toBe(200)
    const s2 = sign(st.body.onChain.xdr)
    const r2 = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: s2.signedXdr })
    expect(r2.body.data).toMatchObject({ status: 'active', onchainStatus: 'active' })
    expect(r2.body.activity).toMatchObject({ hash: s2.hash, type: 'stake', status: 'confirmed' })

    const acts = (await request(app).get(`/api/v1/transactions?vaultId=${id}`)).body.data
    expect(acts.filter((a) => a.hash === s1.hash)).toHaveLength(1)
    expect(acts).toHaveLength(2)

    const late = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: sign(c.body.onChain.xdr).signedXdr })
    expect(late.status).toBe(200) // already recorded -> idempotent replay
  })

  it('rejects an active vault with a new transaction', async () => {
    const c = await request(app).post('/api/v1/vaults').send(body())
    const id = c.body.data.id
    await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: sign(c.body.onChain.xdr).signedXdr })
    const st = await request(app).post(`/api/v1/vaults/${id}/onchain/stake`).send({})
    await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: sign(st.body.onChain.xdr).signedXdr })
    const other = await request(app).post('/api/v1/vaults').send({ ...body(), creator: creatorKp.publicKey() })
    const bad = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: sign(other.body.onChain.xdr).signedXdr })
    expect(bad.status).toBe(409)
  })

  it('returns 400 without broadcasting for XDR built for another vault, or unsigned/garbage', async () => {
    const a = await request(app).post('/api/v1/vaults').send(body())
    const b = await request(app).post('/api/v1/vaults').send({ ...body(), creator: creatorKp.publicKey() })
    const wrong = await request(app).post(`/api/v1/vaults/${a.body.data.id}/onchain/submit`).send({ signedXdr: sign(b.body.onChain.xdr).signedXdr })
    expect(wrong.status).toBe(400)
    const unsigned = await request(app).post(`/api/v1/vaults/${a.body.data.id}/onchain/submit`).send({ signedXdr: a.body.onChain.xdr })
    expect(unsigned.status).toBe(400)
    const junk = await request(app).post(`/api/v1/vaults/${a.body.data.id}/onchain/submit`).send({ signedXdr: 'junk' })
    expect(junk.status).toBe(400)
    const pass = await request(app).post(`/api/v1/vaults/${a.body.data.id}/onchain/submit`).send({ signedXdr: sign(a.body.onChain.xdr).signedXdr, networkPassphrase: 'other' })
    expect(pass.status).toBe(400)
    expect(server.sendTransaction).not.toHaveBeenCalled()
  })

  it('records a failed activity with the decoded error and keeps the vault non-active', async () => {
    const c = await request(app).post('/api/v1/vaults').send(body())
    server.getTransaction.mockResolvedValue({ status: 'FAILED', ledger: 11, diagnosticEventsXdr: [errEvent(16)] })
    const s = sign(c.body.onChain.xdr)
    const r = await request(app).post(`/api/v1/vaults/${c.body.data.id}/onchain/submit`).send({ signedXdr: s.signedXdr })
    expect(r.status).toBe(422)
    expect(r.body.activity).toMatchObject({ status: 'failed', hash: s.hash })
    expect(r.body.activity.memo).toContain('AmountMismatch')
    expect(r.body.data.onchainStatus).toBe('pending_onchain')
    expect(r.body.data.status).toBe('draft')
  })

  it('leaves the op pending on a polling timeout and resumes safely', async () => {
    const c = await request(app).post('/api/v1/vaults').send(body())
    const id = c.body.data.id
    server.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' })
    const s = sign(c.body.onChain.xdr)
    const r = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: s.signedXdr })
    expect(r.status).toBe(202)
    expect(r.body.activity).toMatchObject({ status: 'pending', hash: s.hash })
    expect(r.body.data.onchainStatus).toBe('pending_onchain')

    server.getTransaction.mockResolvedValue({ status: 'SUCCESS', ledger: 99 })
    const r2 = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({ signedXdr: s.signedXdr })
    expect(r2.status).toBe(200)
    expect(r2.body.activity).toMatchObject({ status: 'confirmed', ledger: 99, hash: s.hash })
    const acts = (await request(app).get(`/api/v1/transactions?vaultId=${id}`)).body.data
    expect(acts).toHaveLength(1)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('with Soroban disabled, labels activity as simulated and disables onchain settlement routes', async () => {
    delete process.env.SOROBAN_ENABLED
    const c = await request(app).post('/api/v1/vaults').send(body())
    expect(c.status).toBe(201)
    expect(c.body.data.status).toBe('active')
    expect(c.body.onChain).toBeUndefined()
    const acts = (await request(app).get(`/api/v1/transactions?vaultId=${c.body.data.id}`)).body.data
    expect(acts[0].status).toBe('simulated')

    const id = c.body.data.id
    expect((await request(app).post(`/api/v1/vaults/${id}/onchain/claim-milestone`).send({ index: 0 })).status).toBe(409)
    expect((await request(app).post(`/api/v1/vaults/${id}/onchain/slash`).send({})).status).toBe(409)
    expect((await request(app).post(`/api/v1/vaults/${id}/onchain/withdraw`).send({})).status).toBe(409)
  })

  it('claim_milestone -> sign -> submit, idempotent by tx hash, completes vault when all claimed', async () => {
    const v = await createAndStake()
    const id = v.id
    server.sendTransaction.mockClear()

    const b1 = await request(app).post(`/api/v1/vaults/${id}/onchain/claim-milestone`).send({ milestoneId: v.milestones[0].id })
    expect(b1.status).toBe(200)
    expect(b1.body.onChain.operation).toBe('claim_milestone')
    const s1 = sign(b1.body.onChain.xdr, creatorKp)

    // Wrong milestone index in submit fails expectedArgs verification without broadcasting
    const badIdx = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s1.signedXdr, operation: 'claim_milestone', index: 1,
    })
    expect(badIdx.status).toBe(400)
    expect(server.sendTransaction).not.toHaveBeenCalled()

    const r1 = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s1.signedXdr, operation: 'claim_milestone', milestoneId: v.milestones[0].id,
    })
    expect(r1.status).toBe(200)
    expect(r1.body.activity).toMatchObject({ hash: s1.hash, ledger: 4242, status: 'confirmed', type: 'release' })
    expect(r1.body.data.milestones[0].status).toBe('completed')
    expect(r1.body.data.status).toBe('active')

    // Idempotent replay by tx hash
    const replay = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s1.signedXdr, operation: 'claim_milestone', milestoneId: v.milestones[0].id,
    })
    expect(replay.status).toBe(200)
    expect(replay.body.activity.hash).toBe(s1.hash)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)

    // Claim second milestone -> vault completes
    const b2 = await request(app).post(`/api/v1/vaults/${id}/onchain/claim-milestone`).send({ index: 1 })
    expect(b2.status).toBe(200)
    const s2 = sign(b2.body.onChain.xdr, creatorKp)
    const r2 = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s2.signedXdr, operation: 'claim_milestone', index: 1,
    })
    expect(r2.status).toBe(200)
    expect(r2.body.data.milestones[1].status).toBe('completed')
    expect(r2.body.data.status).toBe('completed')
  })

  it('slash -> sign by verifier -> submit, marks vault failed and is idempotent by tx hash', async () => {
    const v = await createAndStake()
    const id = v.id
    server.sendTransaction.mockClear()

    const b = await request(app).post(`/api/v1/vaults/${id}/onchain/slash`).send({})
    expect(b.status).toBe(200)
    expect(b.body.onChain.operation).toBe('slash_on_miss')

    // Signed by wrong keypair (creator instead of verifier) -> rejected without broadcasting
    const wrongSig = sign(b.body.onChain.xdr, creatorKp)
    const bad = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: wrongSig.signedXdr, operation: 'slash_on_miss',
    })
    expect(bad.status).toBe(400)
    expect(server.sendTransaction).not.toHaveBeenCalled()

    const s = sign(b.body.onChain.xdr, verifierKp)
    const r = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s.signedXdr, operation: 'slash_on_miss',
    })
    expect(r.status).toBe(200)
    expect(r.body.activity).toMatchObject({ hash: s.hash, ledger: 4242, status: 'confirmed', type: 'redirect' })
    expect(r.body.data.status).toBe('failed')
    expect(r.body.data.milestones.every((m) => m.status === 'failed')).toBe(true)

    // Idempotent replay
    const replay = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s.signedXdr, operation: 'slash_on_miss',
    })
    expect(replay.status).toBe(200)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('withdraw -> sign by creator -> submit, marks vault completed and is idempotent by tx hash', async () => {
    const v = await createAndStake()
    const id = v.id
    server.sendTransaction.mockClear()

    const b = await request(app).post(`/api/v1/vaults/${id}/onchain/withdraw`).send({})
    expect(b.status).toBe(200)
    expect(b.body.onChain.operation).toBe('withdraw')

    // Signed by verifier instead of creator -> rejected
    const wrongSig = sign(b.body.onChain.xdr, verifierKp)
    const bad = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: wrongSig.signedXdr, operation: 'withdraw',
    })
    expect(bad.status).toBe(400)
    expect(server.sendTransaction).not.toHaveBeenCalled()

    const s = sign(b.body.onChain.xdr, creatorKp)
    const r = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s.signedXdr, operation: 'withdraw',
    })
    expect(r.status).toBe(200)
    expect(r.body.activity).toMatchObject({ hash: s.hash, ledger: 4242, status: 'confirmed', type: 'release' })
    expect(r.body.data.status).toBe('completed')

    // Idempotent replay
    const replay = await request(app).post(`/api/v1/vaults/${id}/onchain/submit`).send({
      signedXdr: s.signedXdr, operation: 'withdraw',
    })
    expect(replay.status).toBe(200)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
  })
})
