/**
 * Observability state machine for the privacy-safe observability pipeline.
 *
 * Provides per-request, deterministic state tracking across the three
 * middleware components: privacy-logger, tracing, and httpMetrics.
 *
 * ## Design rationale
 *
 * The three observability modules previously operated independently, each
 * attaching its own `res.on('finish', …)` handler with no coordination.
 * This created three concrete failure modes:
 *
 * 1. **Duplicate event recording** — if a handler fires more than once (e.g.
 *    on retry or when Express emits finish for every pipeline stage), the
 *    same request would produce duplicate log lines, metrics, or span
 *    completions, inflating observability signals and confusing dashboards.
 *
 * 2. **No atomic state transitions** — a partial failure (e.g. serialization
 *    error in the privacy-logger) could leave tracing or metrics in an
 *    inconsistent state with no recovery path.
 *
 * 3. **No recovery from interrupted operations** — if one component failed,
 *    downstream components had no signal that an earlier phase had already
 *    completed or failed, making retries opaque.
 *
 * ## State machine
 *
 *     ┌─────────┐    ┌──────────┐    ┌────────┐
 *     │ PENDING  │───▶│ IN_PROGRESS │──▶│  DONE  │
 *     └─────────┘    └──────────┘    └────────┘
 *                           │
 *                           ▼
 *                     ┌──────────┐
 *                     │  FAILED  │
 *                     └──────────┘
 *
 * Transitions:
 *   - PENDING → IN_PROGRESS : operation begins
 *   - IN_PROGRESS → DONE    : operation completed successfully
 *   - IN_PROGRESS → FAILED  : operation failed (error preserved)
 *   - Any attempt to transition from DONE/FAILED is a no-op (idempotent)
 *
 * ## Privacy invariants
 *
 * The state object holds no PII — only operation status codes, timestamps,
 * and error messages (which must not contain credentials; the caller is
 * responsible for scrubbing error messages before recording).
 *
 * ## Memory safety
 *
 * State is stored in a WeakMap keyed on the Express request object.
 * When the request is garbage-collected, the state is automatically
 * reclaimed.  No explicit cleanup is required.
 */

import type { Request } from 'express'

// ── Operation states ─────────────────────────────────────────────────────────

export const OBSERVABILITY_STATES = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  FAILED: 'failed',
} as const

export type ObservabilityOperationState =
  (typeof OBSERVABILITY_STATES)[keyof typeof OBSERVABILITY_STATES]

// ── Operation names ──────────────────────────────────────────────────────────

export type ObservabilityOperation = 'logging' | 'tracing' | 'metrics'

// ── Per-request state ────────────────────────────────────────────────────────

export interface ObservabilityOperationRecord {
  state: ObservabilityOperationState
  startedAt?: number
  completedAt?: number
  error?: string
}

export interface RequestObservabilityState {
  logging: ObservabilityOperationRecord
  tracing: ObservabilityOperationRecord
  metrics: ObservabilityOperationRecord
}

function createInitialState(): RequestObservabilityState {
  return {
    logging: { state: OBSERVABILITY_STATES.PENDING },
    tracing: { state: OBSERVABILITY_STATES.PENDING },
    metrics: { state: OBSERVABILITY_STATES.PENDING },
  }
}

// ── WeakMap storage ──────────────────────────────────────────────────────────

const stateMap = new WeakMap<Request, RequestObservabilityState>()

/**
 * Get or create the observability state for a request.
 * Returns the same object on repeated calls (idempotent).
 */
export function getObservabilityState(req: Request): RequestObservabilityState {
  let state = stateMap.get(req)
  if (!state) {
    state = createInitialState()
    stateMap.set(req, state)
  }
  return state
}

/**
 * Attempt to transition a single operation to the target state.
 * Returns `true` if the transition was applied, `false` if the operation
 * was already in a terminal state (DONE or FAILED) — i.e. the call was
 * a no-op.
 *
 * Valid transitions:
 *   PENDING → IN_PROGRESS
 *   IN_PROGRESS → DONE
 *   IN_PROGRESS → FAILED
 */
export function transitionOperation(
  req: Request,
  operation: ObservabilityOperation,
  targetState: 'in_progress' | 'done' | 'failed',
  error?: string,
): boolean {
  const state = getObservabilityState(req)
  const record = state[operation]
  const now = Date.now()

  // Idempotent: if already terminal, reject the transition.
  if (
    record.state === OBSERVABILITY_STATES.DONE ||
    record.state === OBSERVABILITY_STATES.FAILED
  ) {
    return false
  }

  switch (targetState) {
    case 'in_progress':
      // Only allow from PENDING
      if (record.state !== OBSERVABILITY_STATES.PENDING) return false
      record.state = OBSERVABILITY_STATES.IN_PROGRESS
      record.startedAt = now
      return true

    case 'done':
      // Only allow from IN_PROGRESS
      if (record.state !== OBSERVABILITY_STATES.IN_PROGRESS) return false
      record.state = OBSERVABILITY_STATES.DONE
      record.completedAt = now
      return true

    case 'failed':
      // Allow from PENDING or IN_PROGRESS (partial failure)
      if (
        record.state !== OBSERVABILITY_STATES.PENDING &&
        record.state !== OBSERVABILITY_STATES.IN_PROGRESS
      )
        return false
      record.state = OBSERVABILITY_STATES.FAILED
      record.completedAt = now
      if (error) record.error = error
      return true

    default:
      return false
  }
}

/**
 * Check if an operation is in a terminal state (DONE or FAILED).
 * Useful for skip-if-already-completed guards.
 */
export function isTerminal(req: Request, operation: ObservabilityOperation): boolean {
  const state = getObservabilityState(req)
  const record = state[operation]
  return (
    record.state === OBSERVABILITY_STATES.DONE ||
    record.state === OBSERVABILITY_STATES.FAILED
  )
}

/**
 * Check if all three operations are in a terminal state.
 * Useful for determining when a request's observability pipeline is complete.
 */
export function isFullyResolved(req: Request): boolean {
  return isTerminal(req, 'logging') && isTerminal(req, 'tracing') && isTerminal(req, 'metrics')
}

/**
 * Reset state for a request (test helper).
 * Creates a fresh state object for the given request.
 * In production this is not needed — WeakMap auto-cleans on GC.
 */
export function _resetObservabilityStateForTesting(req: Request): void {
  stateMap.set(req, createInitialState())
}

/**
 * Clear the entire WeakMap (test-only, for full isolation).
 * Note: WeakMap doesn't expose a clear method, so tests should use
 * _resetObservabilityStateForTesting on individual requests instead.
 */
export function _clearAllObservabilityStateForTesting(): void {
  // Intentionally a no-op. See JSDoc above.
}

export default {
  OBSERVABILITY_STATES,
  getObservabilityState,
  transitionOperation,
  isTerminal,
  isFullyResolved,
  _resetObservabilityStateForTesting,
  _clearAllObservabilityStateForTesting,
}
