import { setSorobanLaneDepth } from '../observability/sorobanMetrics.js'

/**
 * Per-source-account submission lane.
 *
 * Only one build -> send -> poll sequence per key runs at a time within this
 * process, so concurrent jobs never build transactions with the same sequence
 * number. Different keys run in parallel.
 *
 * NOTE: this is an in-process guarantee only. Multi-instance deployments must
 * run a single submitter instance or use distinct channel accounts per instance.
 */

export const DEFAULT_MAX_LANE_QUEUE_DEPTH = 100

export class SorobanLaneFullError extends Error {
  readonly code = 'submit_lane_full'
  constructor(key: string, depth: number) {
    super(`Soroban submit lane is full (${depth} pending) for source account ${key.slice(0, 6)}...`)
    this.name = 'SorobanLaneFullError'
  }
}

const tails = new Map<string, Promise<unknown>>()
const depths = new Map<string, number>()
let totalDepth = 0

export function getSubmitLaneDepth(key?: string): number {
  return key === undefined ? totalDepth : (depths.get(key) ?? 0)
}

export async function runInSubmitLane<T>(
  key: string,
  fn: () => Promise<T>,
  maxQueueDepth: number = DEFAULT_MAX_LANE_QUEUE_DEPTH,
): Promise<T> {
  const current = depths.get(key) ?? 0
  if (current >= maxQueueDepth) throw new SorobanLaneFullError(key, current)

  depths.set(key, current + 1)
  totalDepth += 1
  setSorobanLaneDepth(totalDepth)

  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => undefined)
  tails.set(key, tail)

  try {
    return await run
  } finally {
    const remaining = (depths.get(key) ?? 1) - 1
    if (remaining <= 0) {
      depths.delete(key)
      if (tails.get(key) === tail) tails.delete(key)
    } else {
      depths.set(key, remaining)
    }
    totalDepth -= 1
    setSorobanLaneDepth(totalDepth)
  }
}
