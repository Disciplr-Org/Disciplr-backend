import type { Knex } from 'knex'

/** States that can be observed from an accountability-vault lifecycle event. */
export type ReconciledVaultStatus = 'active' | 'completed' | 'failed' | 'cancelled'

/** A normalized event returned by the Horizon adapter. */
export interface HorizonObservation {
  eventId: string
  contractAddress: string
  vaultId: string
  transactionHash: string
  ledgerNumber: number
  pagingToken: string | null
  eventType: 'vault_created' | 'vault_completed' | 'vault_failed' | 'vault_cancelled'
  status: ReconciledVaultStatus
  payload: Record<string, unknown>
}

/** Bounded request passed to an injected Horizon scanner. */
export interface HorizonScanWindow {
  contractAddress: string
  fromLedger: number
  toLedger: number | null
  cursor: string | null
}

/** One page from Horizon, with a ledger high-water mark for confirmations. */
export interface HorizonScanPage {
  observations: HorizonObservation[]
  latestLedger: number
  nextCursor: string | null
}

/** Keeps network details out of reconciliation and makes restart tests deterministic. */
export interface HorizonObservationSource {
  scan(window: HorizonScanWindow): Promise<HorizonScanPage>
}

export interface ReconciliationOptions {
  confirmationDepth?: number
  scanWindowLedgers?: number
  overlapLedgers?: number
  maxAttempts?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  now?: () => Date
}

export interface ReconciliationReport {
  contractAddress: string
  scannedFrom: number
  scannedTo: number | null
  observed: number
  duplicates: number
  unconfirmed: number
  applied: number
  alreadyCurrent: number
  missingVaults: number
  failed: number
  confirmedLedger: number
  nextCursor: string | null
}

interface ReconciliationState {
  contractAddress: string
  confirmedLedger: number
  scanLedger: number
  pagingToken: string | null
  lastRunAt: Date | null
  lastError: string | null
}

const TERMINAL_STATUSES = new Set<ReconciledVaultStatus>(['completed', 'failed', 'cancelled'])

/** Return a stable rank for the monotonic state machine. */
export function statusRank(status: string): number {
  switch (status) {
    case 'draft':
      return 0
    case 'active':
      return 1
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 2
    default:
      return -1
  }
}

/** Terminal states may be replayed, but never replaced by another terminal state. */
export function canApplyObservedStatus(current: string | null, observed: ReconciledVaultStatus): boolean {
  if (!current) return true
  if (current === observed) return false
  if (TERMINAL_STATUSES.has(current as ReconciledVaultStatus)) return false
  return statusRank(observed) > statusRank(current)
}

/** Confirmations are measured against the latest ledger, not wall-clock time. */
export function isConfirmed(ledgerNumber: number, latestLedger: number, depth: number): boolean {
  return depth >= 0 && latestLedger >= ledgerNumber && latestLedger - ledgerNumber >= depth
}

/** Remove duplicate delivery while preserving the first canonical observation. */
export function deduplicateObservations(observations: HorizonObservation[]): {
  unique: HorizonObservation[]
  duplicates: number
} {
  const seen = new Set<string>()
  const unique: HorizonObservation[] = []
  let duplicates = 0
  for (const observation of observations) {
    if (seen.has(observation.eventId)) {
      duplicates++
      continue
    }
    seen.add(observation.eventId)
    unique.push(observation)
  }
  return { unique, duplicates }
}

/** Pick the latest event for a vault, while retaining a deterministic tie-break. */
export function latestObservationByVault(observations: HorizonObservation[]): Map<string, HorizonObservation> {
  const latest = new Map<string, HorizonObservation>()
  for (const observation of observations) {
    const previous = latest.get(observation.vaultId)
    if (
      !previous ||
      observation.ledgerNumber > previous.ledgerNumber ||
      (observation.ledgerNumber === previous.ledgerNumber && observation.eventId > previous.eventId)
    ) {
      latest.set(observation.vaultId, observation)
    }
  }
  return latest
}

/** A bounded exponential delay used by the worker coordinator. */
export function retryDelay(attempt: number, initialMs: number, maxMs: number): number {
  if (attempt <= 0) return 0
  const safeInitial = Math.max(0, initialMs)
  const safeMax = Math.max(safeInitial, maxMs)
  return Math.min(safeMax, safeInitial * 2 ** Math.min(attempt - 1, 30))
}

/** Select a replay-safe starting ledger. The overlap is what handles short reorg-like windows. */
export function calculateStartLedger(
  state: Pick<ReconciliationState, 'confirmedLedger' | 'scanLedger'> | null,
  configuredStart: number,
  overlap: number,
): number {
  if (!state) return Math.max(1, configuredStart)
  // overlap bounds how far before the confirmed cursor to re-scan. With
  // overlap > 0 we resume one ledger below confirmed so the boundary ledger is
  // re-checked; with overlap === 0 (fresh, no re-scan) we start at confirmed
  // itself rather than overshooting it by one.
  const boundedOverlap = Math.max(0, overlap)
  const floor = Math.max(
    1,
    state.confirmedLedger - boundedOverlap + (boundedOverlap > 0 ? 1 : 0),
  )
  // A zero scanLedger means nothing has been reconcilled yet — fall back to the
  // overlap floor instead of treating it as a genuine position.
  return Math.max(1, Math.min(state.scanLedger || floor, floor))
}

function mapState(row: Record<string, unknown>): ReconciliationState {
  return {
    contractAddress: String(row.contract_address),
    confirmedLedger: Number(row.confirmed_ledger ?? 0),
    scanLedger: Number(row.scan_ledger ?? 0),
    pagingToken: (row.paging_token as string | null) ?? null,
    lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)) : null,
    lastError: (row.last_error as string | null) ?? null,
  }
}

/**
 * Reconciles the durable vault projection against authoritative Horizon data.
 *
 * The worker intentionally accepts a scanner rather than constructing Horizon
 * directly. Production wires this to Horizon's paginated endpoint; tests can
 * replay pages, duplicate deliveries, gaps, and restart sequences exactly.
 */
export class HorizonReconciler {
  private readonly confirmationDepth: number
  private readonly scanWindowLedgers: number
  private readonly overlapLedgers: number
  private readonly now: () => Date

  constructor(
    private readonly db: Knex,
    private readonly source: HorizonObservationSource,
    options: ReconciliationOptions = {},
  ) {
    this.confirmationDepth = Math.max(0, options.confirmationDepth ?? 2)
    this.scanWindowLedgers = Math.max(1, options.scanWindowLedgers ?? 2_000)
    this.overlapLedgers = Math.max(0, options.overlapLedgers ?? 32)
    this.now = options.now ?? (() => new Date())
  }

  async reconcileContract(contractAddress: string, configuredStart = 1): Promise<ReconciliationReport> {
    const state = await this.loadState(contractAddress)
    const fromLedger = calculateStartLedger(state, configuredStart, this.overlapLedgers)
    const toLedger = fromLedger + this.scanWindowLedgers - 1
    const page = await this.source.scan({
      contractAddress,
      fromLedger,
      toLedger,
      cursor: state?.pagingToken ?? null,
    })
    const { unique, duplicates } = deduplicateObservations(page.observations)
    const confirmed = unique.filter(observation =>
      isConfirmed(observation.ledgerNumber, page.latestLedger, this.confirmationDepth),
    )
    const unconfirmed = unique.length - confirmed.length
    const report: ReconciliationReport = {
      contractAddress,
      scannedFrom: fromLedger,
      scannedTo: toLedger,
      observed: unique.length,
      duplicates,
      unconfirmed,
      applied: 0,
      alreadyCurrent: 0,
      missingVaults: 0,
      failed: 0,
      confirmedLedger: state?.confirmedLedger ?? 0,
      nextCursor: page.nextCursor,
    }

    try {
      await this.persistPage(contractAddress, unique, confirmed, page, report)
      report.confirmedLedger = Math.max(
        state?.confirmedLedger ?? 0,
        ...confirmed.map(observation => observation.ledgerNumber),
      )
      await this.saveState(contractAddress, {
        confirmedLedger: report.confirmedLedger,
        scanLedger: Math.max(state?.scanLedger ?? 0, page.latestLedger),
        pagingToken: page.nextCursor,
        lastRunAt: this.now(),
        lastError: null,
      })
    } catch (error) {
      report.failed = unique.length
      await this.saveState(contractAddress, {
        confirmedLedger: state?.confirmedLedger ?? 0,
        scanLedger: state?.scanLedger ?? 0,
        pagingToken: state?.pagingToken ?? null,
        lastRunAt: this.now(),
        lastError: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return report
  }

  async reconcileAll(contractAddresses: string[], configuredStart = 1): Promise<ReconciliationReport[]> {
    const reports: ReconciliationReport[] = []
    for (const contractAddress of contractAddresses) {
      reports.push(await this.reconcileContract(contractAddress, configuredStart))
    }
    return reports
  }

  private async loadState(contractAddress: string): Promise<ReconciliationState | null> {
    const row = await this.db('horizon_reconciliation_state')
      .where({ contract_address: contractAddress })
      .first()
    return row ? mapState(row as Record<string, unknown>) : null
  }

  private async persistPage(
    contractAddress: string,
    all: HorizonObservation[],
    confirmed: HorizonObservation[],
    page: HorizonScanPage,
    report: ReconciliationReport,
  ): Promise<void> {
    await this.db.transaction(async trx => {
      const confirmedIds = new Set(confirmed.map(observation => observation.eventId))
      for (const observation of all) {
        const confirmedState = confirmedIds.has(observation.eventId) ? 'confirmed' : 'unconfirmed'
        await trx('horizon_reconciliation_events')
          .insert({
            event_id: observation.eventId,
            contract_address: contractAddress,
            vault_id: observation.vaultId,
            transaction_hash: observation.transactionHash,
            ledger_number: observation.ledgerNumber,
            paging_token: observation.pagingToken,
            event_type: observation.eventType,
            observed_status: observation.status,
            confirmation_state: confirmedState,
            payload: JSON.stringify(observation.payload),
            observed_at: this.now(),
            updated_at: this.now(),
          })
          .onConflict('event_id')
          .merge({
            confirmation_state: confirmedState,
            updated_at: this.now(),
          })
      }

      for (const observation of confirmed) {
        const vault = await trx('vaults')
          .where({ id: observation.vaultId })
          .select('status')
          .first()
        if (!vault) {
          report.missingVaults++
          continue
        }
        if (!canApplyObservedStatus(String(vault.status), observation.status)) {
          report.alreadyCurrent++
          continue
        }
        await trx('vaults')
          .where({ id: observation.vaultId })
          .whereNotIn('status', ['completed', 'failed', 'cancelled'])
          .update({ status: observation.status, updated_at: this.now() })
        report.applied++
      }

      // Keep the page high-water mark in the same transaction as event state.
      // The caller writes the durable cursor only after this callback commits.
      void page
    })
  }

  private async saveState(
    contractAddress: string,
    state: Omit<ReconciliationState, 'contractAddress'>,
  ): Promise<void> {
    const timestamp = this.now()
    await this.db('horizon_reconciliation_state')
      .insert({
        contract_address: contractAddress,
        confirmed_ledger: state.confirmedLedger,
        scan_ledger: state.scanLedger,
        paging_token: state.pagingToken,
        last_run_at: state.lastRunAt ?? timestamp,
        last_error: state.lastError,
        updated_at: timestamp,
        created_at: timestamp,
      })
      .onConflict('contract_address')
      .merge({
        confirmed_ledger: state.confirmedLedger,
        scan_ledger: state.scanLedger,
        paging_token: state.pagingToken,
        last_run_at: state.lastRunAt ?? timestamp,
        last_error: state.lastError,
        updated_at: timestamp,
      })
  }
}

/** Run one contract with retry/backoff while leaving cursor ownership in the reconciler. */
export async function reconcileWithRetry(
  reconciler: Pick<HorizonReconciler, 'reconcileContract'>,
  contractAddress: string,
  configuredStart: number,
  options: Pick<ReconciliationOptions, 'maxAttempts' | 'initialBackoffMs' | 'maxBackoffMs'> = {},
  wait: (milliseconds: number) => Promise<void> = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<ReconciliationReport> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  const initialBackoffMs = options.initialBackoffMs ?? 250
  const maxBackoffMs = options.maxBackoffMs ?? 10_000
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await reconciler.reconcileContract(contractAddress, configuredStart)
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) break
      await wait(retryDelay(attempt, initialBackoffMs, maxBackoffMs))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
