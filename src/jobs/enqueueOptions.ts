import type { EnqueueOptions } from './types.js'

export interface EnqueueOptionInput {
  delayMs?: number
  maxAttempts?: number
}

export const parseEnqueueOptions = (input: EnqueueOptionInput): EnqueueOptions => {
  return {
    delayMs: input.delayMs !== undefined ? Math.floor(input.delayMs) : undefined,
    maxAttempts: input.maxAttempts,
  }
}
