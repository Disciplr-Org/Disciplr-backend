import type { EnqueueOptions } from './types.js'

export interface EnqueueOptionInput {
  delayMs?: number
  maxAttempts?: number
}

const isValidMaxAttempts = (maxAttempts: unknown): maxAttempts is number => {
  return (
    typeof maxAttempts === 'number' &&
    Number.isInteger(maxAttempts) &&
    maxAttempts >= 1 &&
    maxAttempts <= 10
  )
}

export const parseEnqueueOptions = (input: EnqueueOptionInput): EnqueueOptions | null => {
  const delayMs = input.delayMs
  if (delayMs !== undefined) {
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) {
      return null
    }

    const normalizedDelayMs = Math.floor(delayMs)
    if (normalizedDelayMs < 0) {
      return null
    }

    const maxAttempts = input.maxAttempts
    if (maxAttempts !== undefined && !isValidMaxAttempts(maxAttempts)) {
      return null
    }

    return {
      delayMs: normalizedDelayMs,
      maxAttempts,
    }
  }

  const maxAttempts = input.maxAttempts
  if (maxAttempts !== undefined && !isValidMaxAttempts(maxAttempts)) {
    return null
  }

  return {
    delayMs: undefined,
    maxAttempts,
  }
}
