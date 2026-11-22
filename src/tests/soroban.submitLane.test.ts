import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import type { SorobanConfig } from '../services/soroban.js'
import { createDefaultSorobanClient, resetRpcPool, SorobanTxError, decodeTxResult } from '../services/soroban.js'
import { getSubmitLaneDepth, runInSubmitLane, SorobanLaneFullError } from '../services/sorobanSubmitLane.js'
import { register } from '../observability/metricsRegistry.js'

const stellar = (c = 'A'): string => `G${c.repeat(55)}`
const URL_A = 'https://rpc-lane.example.com'

const config = (sourceAccount = stellar(), extra: Partial<SorobanConfig> = {}): SorobanConfig => ({
  contractId: 'CABCDEF1234567890',
  networkPassphrase: 'Test SDF Network ; September 2015',
  sourceAccount,
  secretKey: 'SCZANGBA5YHTNYVVV3C7CAZMCLPVAR3LXKLHEADMPROMU3QAHZGOSN6A',
  rpcUrls: [URL_A],
  rpcUrl: URL_A,
  submitPollIntervalMs: 1,
  submitPollMaxAttempts: 3,
  rpcTimeoutMs: 5_000,
  submitTimeoutMs: 10_000,
  submitRetry: { maxAttempts: 1, initialBackoffMs: 1, maxBackoffMs: 1, backoffMultiplier: 1, jitterFactor: 0 },
  ...extra,
})

const VAULT_ARGS = {
  vaultId: 'v1',
  amount: '1000',
  verifier: stellar('B'),
  successDestination: stellar('C'),
  failureDestination: stellar('D'),
}

const txCode = (name: string) => ({ result: () => ({ switch: () => ({ name }) }) })

type Script = {
  sendStatuses?: Array<{ status: string; errorResult?: unknown }>
  getTx?: any
  /** Build the first transaction with a stale sequence number. */
  staleFirst?: boolean
}

/** Fake SDK whose rpc.Server tracks account sequences and rejects stale ones with txBadSeq. */
const makeSdk = (script: Script = {}) => {
  const seqs = new Map<string, number>()
  const inFlight = new Map<string, number>()
  const maxInFlight = new Map<string, number>()
  const sentHashes: string[] = []
  const state = { built: 0, sendCalls: 0 }
  const queue = [...(script.sendStatuses ?? [])]
  let stale = script.staleFirst === true

  const sdk = async () => ({
    Keypair: { fromSecret: () => ({ sign: () => undefined }) },
    Contract: class { call = () => ({}) },
    rpc: {
      Server: class {
        async getAccount(id: string) {
          const cur = (inFlight.get(id) ?? 0) + 1
          inFlight.set(id, cur)
          maxInFlight.set(id, Math.max(maxInFlight.get(id) ?? 0, cur))
          if (!seqs.has(id)) seqs.set(id, 100)
          return { id, seq: seqs.get(id)! }
        }
        async prepareTransaction(tx: any) { return tx }
        async sendTransaction(tx: any) {
          state.sendCalls++
          sentHashes.push(tx.hash)
          const scripted = queue.shift()
          if (scripted) return { hash: tx.hash, ...scripted }
          const ok = tx.seq === seqs.get(tx.source)! + 1
          if (ok) seqs.set(tx.source, tx.seq)
          inFlight.set(tx.source, (inFlight.get(tx.source) ?? 1) - 1)
          if (!ok) return { status: 'ERROR', hash: tx.hash, errorResult: txCode('txBadSeq') }
          return { status: 'PENDING', hash: tx.hash }
        }
        async getTransaction() {
          return script.getTx ?? { status: 'SUCCESS' }
        }
      },
    },
    TransactionBuilder: class {
      acct: any
      constructor(acct: any) { this.acct = acct }
      addOperation() { return this }
      setTimeout() { return this }
      build() {
        state.built++
        let seq = this.acct.seq + 1
        if (stale) { stale = false; seq = this.acct.seq - 5 }
        return { source: this.acct.id, seq, hash: `hash-${seq}-${state.built}`, sign() {} }
      }
    },
    nativeToScVal: (v: unknown) => v,
    xdr: { ScVal: { scvBytes: (b: unknown) => b } },
    BASE_FEE: '100',
  })
  return { sdk, maxInFlight, sentHashes, state }
}

const submit = (cfg: SorobanConfig, sdk: any) =>
  createDefaultSorobanClient(sdk).submitVaultCreation(cfg, VAULT_ARGS)

beforeEach(() => resetRpcPool())
afterEach(() => { resetRpcPool(); jest.useRealTimers() })

describe('submit lane', () => {
  it('runs 10 concurrent submissions on one account sequentially and all succeed', async () => {
    const f = makeSdk()
    const results = await Promise.all(Array.from({ length: 10 }, () => submit(config(), f.sdk)))
    expect(results).toHaveLength(10)
    expect(f.maxInFlight.get(stellar())).toBe(1)
    expect(f.state.built).toBe(10)
    expect(getSubmitLaneDepth()).toBe(0)
  })

  it('runs different accounts in parallel', async () => {
    let active = 0
    let peak = 0
    const task = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active-- }
    await Promise.all([runInSubmitLane('a', task), runInSubmitLane('b', task)])
    expect(peak).toBe(2)
  })

  it('releases the lane when a task throws and fails fast when full', async () => {
    await expect(runInSubmitLane('x', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(getSubmitLaneDepth('x')).toBe(0)
    const first = runInSubmitLane('y', () => new Promise<void>((r) => setTimeout(r, 20)), 1)
    await expect(runInSubmitLane('y', async () => 1, 1)).rejects.toBeInstanceOf(SorobanLaneFullError)
    await first
  })

  it('exports the lane depth metric', async () => {
    const f = makeSdk()
    await submit(config(), f.sdk)
    expect(await register.metrics()).toContain('disciplr_soroban_submit_lane_depth')
  })
})

describe('sendTransaction statuses', () => {
  it('resends the same envelope on TRY_AGAIN_LATER then succeeds', async () => {
    const f = makeSdk({ sendStatuses: [{ status: 'TRY_AGAIN_LATER' }, { status: 'TRY_AGAIN_LATER' }] })
    const r = await submit(config(), f.sdk)
    expect(f.state.sendCalls).toBe(3)
    expect(new Set(f.sentHashes).size).toBe(1)
    expect(f.state.built).toBe(1)
    expect(r.txHash).toBe(f.sentHashes[0])
  })

  it('fails with try_again_later_exhausted after bounded resends', async () => {
    const f = makeSdk({ sendStatuses: Array.from({ length: 10 }, () => ({ status: 'TRY_AGAIN_LATER' })) })
    const err: any = await submit(config(), f.sdk).catch((e) => e)
    expect(err).toBeInstanceOf(SorobanTxError)
    expect(err.code).toBe('try_again_later_exhausted')
    expect(f.state.sendCalls).toBe(4)
    expect(new Set(f.sentHashes).size).toBe(1)
  })

  it('polls the existing hash on DUPLICATE', async () => {
    const f = makeSdk({ sendStatuses: [{ status: 'DUPLICATE' }] })
    const r = await submit(config(), f.sdk)
    expect(r.txHash).toBe(f.sentHashes[0])
    expect(f.state.sendCalls).toBe(1)
  })

  it('rebuilds exactly once with a fresh sequence on txBadSeq', async () => {
    const f = makeSdk({ staleFirst: true })
    const r = await submit(config(), f.sdk)
    expect(r.txHash).toBeDefined()
    expect(f.state.built).toBe(2)
    expect(f.state.sendCalls).toBe(2)
  })

  it('does not rebuild a second time when txBadSeq persists', async () => {
    const bad = { status: 'ERROR', errorResult: txCode('txBadSeq') }
    const f = makeSdk({ sendStatuses: [bad, bad, bad] })
    const err: any = await submit(config(), f.sdk).catch((e) => e)
    expect(err).toBeInstanceOf(SorobanTxError)
    expect(err.code).toBe('txBadSeq')
    expect(f.state.built).toBe(2)
  })

  it('reports expired when the validity window passes', async () => {
    jest.useFakeTimers()
    const f = makeSdk({ getTx: { status: 'NOT_FOUND' } })
    const cfg = config(stellar('E'), {
      txTimeoutSecs: 1,
      submitPollMaxAttempts: 1000,
      submitTimeoutMs: 1_000_000,
      submitPollIntervalMs: 1_000,
    })
    const p = submit(cfg, f.sdk).catch((e) => e)
    await jest.advanceTimersByTimeAsync(20_000)
    const err: any = await p
    expect(err).toBeInstanceOf(SorobanTxError)
    expect(err.kind).toBe('expired')
  })

  it('maps a FAILED contract error to { kind: contract, code }', async () => {
    const failed = {
      status: 'FAILED',
      resultXdr: {
        result: () => ({
          switch: () => ({ name: 'txFailed' }),
          results: () => [{ tr: () => ({ value: () => ({ switch: () => ({ name: 'invokeHostFunctionTrapped' }) }) }) }],
        }),
      },
    }
    const f = makeSdk({ getTx: failed })
    const err: any = await submit(config(stellar('F')), f.sdk).catch((e) => e)
    expect(err).toBeInstanceOf(SorobanTxError)
    expect({ kind: err.kind, code: err.code }).toEqual({ kind: 'contract', code: 'invokeHostFunctionTrapped' })
  })

  it('decodes a tx-level code', () => {
    expect(decodeTxResult(txCode('txBadSeq'), {})).toEqual({ kind: 'tx', code: 'txBadSeq' })
  })
})
