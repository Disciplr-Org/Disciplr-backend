import { addToDLQ } from '../services/dlq.js'

interface JobConfig {
  maxRetries: number
  retryDelayMs: number
}

const defaultConfig: JobConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
}

export const processJobWithDLQ = async <T>(
  jobType: string,
  payload: Record<string, unknown>,
  handler: (payload: Record<string, unknown>) => Promise<T>,
  config: Partial<JobConfig> = {},
): Promise<{ success: boolean; result?: T; dlqId?: string }> => {
  const { maxRetries, retryDelayMs } = { ...defaultConfig, ...config }
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await handler(payload)
      return { success: true, result }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)))
      }
    }
  }

  const dlqEntry = addToDLQ(jobType, payload, lastError!, maxRetries)
  return { success: false, dlqId: dlqEntry.id }
}
