/**
 * sorobanBoot.ts
 *
 * Startup precheck for the Soroban source account on Stellar testnet.
 * When the configured network is the public testnet and the source account
 * has no XLM balance, this module calls Stellar Friendbot to fund it so the
 * first vault-creation transaction does not fail with "account not found".
 *
 * Friendbot is only available on testnet; this module is a no-op on mainnet
 * or when Soroban submit mode is not configured.
 */

import { getSorobanConfig, type SorobanConfig } from './soroban.js'

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'
export const FRIENDBOT_URL = 'https://friendbot.stellar.org'

export type FriendBotFetch = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
type ConfigFn = () => SorobanConfig | null

export interface SorobanBootResult {
  /** Whether the precheck ran (false when Soroban is not configured or wrong network). */
  ran: boolean
  /** Whether the source account was already funded. */
  alreadyFunded?: boolean
  /** Whether friendbot was successfully called. */
  funded?: boolean
  /** Non-fatal error message if the precheck failed. */
  error?: string
}

const log = (level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}): void => {
  const entry = { level, service: 'disciplr-backend', component: 'soroban-boot', event, ts: new Date().toISOString(), ...data }
  level === 'error' ? console.error(JSON.stringify(entry)) : console.log(JSON.stringify(entry))
}

/**
 * Checks the source account balance via the Horizon REST API.
 * Returns true when the account exists (HTTP 200), false when not found (HTTP 404).
 */
export async function isAccountFunded(
  sourceAccount: string,
  rpcUrl: string,
  fetchFn: FriendBotFetch = globalThis.fetch as FriendBotFetch,
): Promise<boolean> {
  const parsed = new URL(rpcUrl)
  const horizonBase = `${parsed.protocol}//${parsed.host}`
  const res = await fetchFn(`${horizonBase}/accounts/${sourceAccount}`)
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`Horizon account lookup failed: HTTP ${res.status}`)
  return true
}

/**
 * Calls Friendbot to fund the given Stellar testnet account.
 */
export async function callFriendbot(
  sourceAccount: string,
  fetchFn: FriendBotFetch = globalThis.fetch as FriendBotFetch,
): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(sourceAccount)}`
  const res = await fetchFn(url)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Friendbot request failed: HTTP ${res.status} — ${body}`)
  }
}

/**
 * Runs the testnet funding precheck. Safe to call at startup; never throws.
 *
 * - No-op when Soroban is not configured (submit mode disabled).
 * - No-op on non-testnet networks (guards against accidental mainnet calls).
 * - Calls Friendbot only when the source account is unfunded.
 *
 * @param fetchFn  Injectable fetch implementation (defaults to globalThis.fetch).
 * @param configFn Injectable config loader (defaults to getSorobanConfig).
 */
export async function runSorobanBootPrecheck(
  fetchFn: FriendBotFetch = globalThis.fetch as FriendBotFetch,
  configFn: ConfigFn = getSorobanConfig,
): Promise<SorobanBootResult> {
  const config = configFn()
  if (!config) return { ran: false }

  if (config.networkPassphrase !== TESTNET_PASSPHRASE) {
    log('info', 'soroban.boot.skipped', { reason: 'not-testnet' })
    return { ran: false }
  }

  try {
    const rpcUrl = (config as any).rpcUrls?.[0] ?? (config as any).rpcUrl
    const funded = await isAccountFunded(config.sourceAccount, rpcUrl, fetchFn)
    if (funded) {
      log('info', 'soroban.boot.already_funded', { account: config.sourceAccount })
      return { ran: true, alreadyFunded: true, funded: false }
    }

    log('info', 'soroban.boot.funding', { account: config.sourceAccount })
    await callFriendbot(config.sourceAccount, fetchFn)
    log('info', 'soroban.boot.funded', { account: config.sourceAccount })
    return { ran: true, alreadyFunded: false, funded: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('warn', 'soroban.boot.error', { error: message })
    return { ran: true, alreadyFunded: false, funded: false, error: message }
  }
}

// ─── Module-level result cached for health checks ─────────────────────────

let _bootResult: SorobanBootResult | null = null

/**
 * Runs the precheck once and caches the result.
 * Subsequent calls return the cached result without re-running.
 */
export async function ensureSorobanBootPrecheck(
  fetchFn?: FriendBotFetch,
  configFn?: ConfigFn,
): Promise<SorobanBootResult> {
  if (_bootResult !== null) return _bootResult
  _bootResult = await runSorobanBootPrecheck(fetchFn, configFn)
  return _bootResult
}

/** Returns the cached boot result (null if not yet run). */
export const getSorobanBootResult = (): SorobanBootResult | null => _bootResult

/** Resets the cached result — for testing only. */
export const resetSorobanBootResult = (): void => {
  _bootResult = null
}
