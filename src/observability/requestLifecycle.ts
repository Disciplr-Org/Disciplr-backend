/**
 * Request Lifecycle State Machine
 *
 * Provides deterministic, atomic, and idempotent state tracking for
 * request-level observability. Each request transitions through a well-defined
 * state machine:
 *
 *   CREATED ──→ ACTIVE ──→ COMPLETED
 *                    │
 *                    ├──→ FAILED
 *                    │
 *                    └──→ CANCELLED
 *
 * Invariants enforced:
 *   - Terminal states (COMPLETED, FAILED, CANCELLED) are absorbing: once
 *     reached, further transition() calls are no-ops that return the current state.
 *   - Transitions from CREATED directly to terminal states (e.g. middleware skip)
 *     are allowed for short-circuited requests.
 *   - Transitions from COMPLETED/FAILED/CANCELLED to ACTIVE are never allowed.
 *   - register() and deregister() maintain the active-request registry so that
 *     concurrent or stale handlers can be detected.
 *
 * This module is pure synchronous code — no I/O, no timers, no side effects
 * beyond the module-level registry Map.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type RequestState =
  | 'CREATED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

interface LifecycleEntry {
  state: RequestState
  createdAt: number
  method?: string
  path?: string
}

/**
 * Allowed transitions: from → Set<to>.
 * Any transition not listed here is rejected (returns current state).
 */
const ALLOWED_TRANSITIONS: Record<RequestState, Set<RequestState>> = {
  CREATED: new Set<RequestState>(['ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED']),
  ACTIVE: new Set<RequestState>(['COMPLETED', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set<RequestState>(),
  FAILED: new Set<RequestState>(),
  CANCELLED: new Set<RequestState>(),
}

// ── Module-level registry ───────────────────────────────────────────────────

const registry = new Map<string, LifecycleEntry>()

/**
 * Register a new request in the lifecycle.
 * If the request ID already exists (e.g. retried), the entry is reset to
 * CREATED so downstream handlers see a clean slate.
 */
export function register(
  requestId: string,
  meta?: { method?: string; path?: string },
): void {
  registry.set(requestId, {
    state: 'CREATED',
    createdAt: Date.now(),
    method: meta?.method,
    path: meta?.path,
  })
}

/**
 * Retrieve the current lifecycle entry for a request.
 * Returns undefined if the request is not registered.
 */
export function get(requestId: string): LifecycleEntry | undefined {
  return registry.get(requestId)
}

/**
 * Deregister a request from the lifecycle.
 * Safe to call with unknown IDs (no-op).
 */
export function deregister(requestId: string): void {
  registry.delete(requestId)
}

/**
 * Return the number of currently active (registered) requests.
 * Useful for metrics and diagnostics.
 */
export function activeCount(): number {
  return registry.size
}

// ── State transitions ───────────────────────────────────────────────────────

/**
 * Atomically transition a request to the given target state.
 *
 * Behavior:
 *   - If the request is not registered, registers it in CREATED then transitions.
 *   - If the request is already in the target state, returns the current state
 *     (idempotent).
 *   - If the transition is invalid (e.g. ACTIVE → CREATED), returns the current
 *     state without mutating it.
 *   - Terminal states are absorbing: once COMPLETED/FAILED/CANCELLED, no
 *     further transitions are possible.
 *
 * @returns The resulting state after the transition attempt.
 */
export function transition(requestId: string, target: RequestState): RequestState {
  let entry = registry.get(requestId)

  if (!entry) {
    // Auto-register for callers that skip the register() step
    entry = { state: 'CREATED', createdAt: Date.now() }
    registry.set(requestId, entry)
  }

  // Idempotent: already in target state
  if (entry.state === target) {
    return entry.state
  }

  // Check transition validity
  const allowed = ALLOWED_TRANSITIONS[entry.state]
  if (allowed.has(target)) {
    entry.state = target
    return entry.state
  }

  // Invalid transition — return current state without mutation
  return entry.state
}
