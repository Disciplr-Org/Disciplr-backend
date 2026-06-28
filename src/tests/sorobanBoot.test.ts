import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'

import {
  isAccountFunded,
  callFriendbot,
  runSorobanBootPrecheck,
  ensureSorobanBootPrecheck,
  getSorobanBootResult,
  resetSorobanBootResult,
  TESTNET_PASSPHRASE,
  FRIENDBOT_URL,
} from '../services/sorobanBoot.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SOURCE = 'G' + 'A'.repeat(55)
const RPC_URL = 'https://soroban-testnet.stellar.org'

const testnetConfig = () => ({
  networkPassphrase: TESTNET_PASSPHRASE,
  sourceAccount: SOURCE,
  rpcUrl: RPC_URL,
})

const okFetch = (body = '{}') =>
  jest.fn<any>().mockResolvedValue({ ok: true, status: 200, text: async () => body })

const notFoundFetch = () =>
  jest.fn<any>().mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' })

const errorFetch = (status = 500, body = 'server error') =>
  jest.fn<any>().mockResolvedValue({ ok: false, status, text: async () => body })

// ─── isAccountFunded ──────────────────────────────────────────────────────────

describe('isAccountFunded', () => {
  it('returns true when Horizon returns 200', async () => {
    const fetch = okFetch()
    expect(await isAccountFunded(SOURCE, RPC_URL, fetch)).toBe(true)
    expect((fetch.mock.calls[0] as any[])[0]).toContain(`/accounts/${SOURCE}`)
  })

  it('strips the RPC path and uses only the host for Horizon base URL', async () => {
    const fetch = okFetch()
    await isAccountFunded(SOURCE, 'https://soroban-testnet.stellar.org/rpc/path', fetch)
    const url: string = (fetch.mock.calls[0] as any[])[0]
    expect(url).toMatch(/^https:\/\/soroban-testnet\.stellar\.org\/accounts\//)
  })

  it('returns false when Horizon returns 404', async () => {
    expect(await isAccountFunded(SOURCE, RPC_URL, notFoundFetch())).toBe(false)
  })

  it('throws on unexpected HTTP error', async () => {
    await expect(isAccountFunded(SOURCE, RPC_URL, errorFetch(503))).rejects.toThrow('HTTP 503')
  })
})

// ─── callFriendbot ────────────────────────────────────────────────────────────

describe('callFriendbot', () => {
  it('calls the correct friendbot URL with encoded account', async () => {
    const fetch = okFetch()
    await callFriendbot(SOURCE, fetch)
    const url: string = (fetch.mock.calls[0] as any[])[0]
    expect(url).toContain(FRIENDBOT_URL)
    expect(url).toContain(encodeURIComponent(SOURCE))
  })

  it('throws on non-ok response and includes body in message', async () => {
    await expect(callFriendbot(SOURCE, errorFetch(400, 'bad account'))).rejects.toThrow('bad account')
  })
})

// ─── runSorobanBootPrecheck ───────────────────────────────────────────────────

describe('runSorobanBootPrecheck', () => {
  it('returns {ran:false} when Soroban is not configured', async () => {
    expect(await runSorobanBootPrecheck(undefined, () => null)).toEqual({ ran: false })
  })

  it('returns {ran:false} on non-testnet network', async () => {
    const cfg = { ...testnetConfig(), networkPassphrase: 'Public Global Stellar Network ; September 2015' }
    expect(await runSorobanBootPrecheck(undefined, () => cfg as any)).toEqual({ ran: false })
  })

  it('returns alreadyFunded:true and does NOT call friendbot when account exists', async () => {
    const fetch = okFetch()
    const result = await runSorobanBootPrecheck(fetch, () => testnetConfig() as any)
    expect(result).toEqual({ ran: true, alreadyFunded: true, funded: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('calls friendbot and returns funded:true when account is unfunded', async () => {
    const fetch = jest.fn<any>()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' })
    const result = await runSorobanBootPrecheck(fetch, () => testnetConfig() as any)
    expect(result).toEqual({ ran: true, alreadyFunded: false, funded: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns error result without throwing when horizon lookup fails', async () => {
    const fetch = jest.fn<any>().mockRejectedValue(new Error('network timeout'))
    const result = await runSorobanBootPrecheck(fetch, () => testnetConfig() as any)
    expect(result.ran).toBe(true)
    expect(result.funded).toBe(false)
    expect(result.error).toMatch(/network timeout/)
  })

  it('returns error result without throwing when friendbot call fails', async () => {
    const fetch = jest.fn<any>()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
    const result = await runSorobanBootPrecheck(fetch, () => testnetConfig() as any)
    expect(result.ran).toBe(true)
    expect(result.funded).toBe(false)
    expect(result.error).toMatch(/rate limited/)
  })
})

// ─── ensureSorobanBootPrecheck (caching) ─────────────────────────────────────

describe('ensureSorobanBootPrecheck', () => {
  beforeEach(() => resetSorobanBootResult())
  afterEach(() => resetSorobanBootResult())

  it('runs the precheck on first call', async () => {
    expect(await ensureSorobanBootPrecheck(undefined, () => null)).toEqual({ ran: false })
  })

  it('returns cached result without re-running on subsequent calls', async () => {
    const fetch = okFetch()
    const first = await ensureSorobanBootPrecheck(fetch, () => testnetConfig() as any)
    expect(first.alreadyFunded).toBe(true)
    const second = await ensureSorobanBootPrecheck(fetch, () => testnetConfig() as any)
    expect(second).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

// ─── getSorobanBootResult ─────────────────────────────────────────────────────

describe('getSorobanBootResult', () => {
  beforeEach(() => resetSorobanBootResult())
  afterEach(() => resetSorobanBootResult())

  it('returns null before any precheck has run', () => {
    expect(getSorobanBootResult()).toBeNull()
  })

  it('returns the cached result after a precheck', async () => {
    await ensureSorobanBootPrecheck(undefined, () => null)
    expect(getSorobanBootResult()).toEqual({ ran: false })
  })
})
