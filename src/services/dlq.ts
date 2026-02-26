interface DLQEntry {
  id: string
  jobType: string
  payload: Record<string, unknown>
  errorMessage: string
  stackTrace?: string
  retryCount: number
  firstFailedAt: string
  lastFailedAt: string
  status: 'pending' | 'reprocessing' | 'discarded'
  resolvedAt?: string
}

const dlqTable: DLQEntry[] = []

export const addToDLQ = (
  jobType: string,
  payload: Record<string, unknown>,
  error: Error,
  retryCount = 0,
): DLQEntry => {
  const now = new Date().toISOString()
  const entry: DLQEntry = {
    id: crypto.randomUUID(),
    jobType,
    payload,
    errorMessage: error.message,
    stackTrace: error.stack,
    retryCount,
    firstFailedAt: now,
    lastFailedAt: now,
    status: 'pending',
  }

  dlqTable.push(entry)
  return entry
}

export const listDLQEntries = (filters?: {
  jobType?: string
  status?: 'pending' | 'reprocessing' | 'discarded'
}): DLQEntry[] => {
  let result = [...dlqTable]

  if (filters?.jobType) {
    result = result.filter((e) => e.jobType === filters.jobType)
  }

  if (filters?.status) {
    result = result.filter((e) => e.status === filters.status)
  }

  return result.sort((a, b) => new Date(b.lastFailedAt).getTime() - new Date(a.lastFailedAt).getTime())
}

export const getDLQEntry = (id: string): DLQEntry | null => {
  return dlqTable.find((e) => e.id === id) || null
}

export const discardDLQEntry = (id: string): DLQEntry | null => {
  const entry = dlqTable.find((e) => e.id === id)
  if (!entry) return null

  entry.status = 'discarded'
  entry.resolvedAt = new Date().toISOString()
  return entry
}

export const reprocessDLQEntry = async (
  id: string,
  handler: (payload: Record<string, unknown>) => Promise<void>,
): Promise<{ success: boolean; error?: string }> => {
  const entry = dlqTable.find((e) => e.id === id)
  if (!entry) {
    return { success: false, error: 'Entry not found' }
  }

  if (entry.status === 'discarded') {
    return { success: false, error: 'Entry already discarded' }
  }

  entry.status = 'reprocessing'

  try {
    await handler(entry.payload)
    entry.resolvedAt = new Date().toISOString()
    return { success: true }
  } catch (error) {
    entry.status = 'pending'
    entry.retryCount += 1
    entry.lastFailedAt = new Date().toISOString()
    entry.errorMessage = error instanceof Error ? error.message : String(error)
    entry.stackTrace = error instanceof Error ? error.stack : undefined
    return { success: false, error: entry.errorMessage }
  }
}

export const getDLQMetrics = () => {
  const byType = dlqTable.reduce(
    (acc, entry) => {
      acc[entry.jobType] = (acc[entry.jobType] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  const byStatus = dlqTable.reduce(
    (acc, entry) => {
      acc[entry.status] = (acc[entry.status] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  return {
    total: dlqTable.length,
    pending: byStatus.pending || 0,
    reprocessing: byStatus.reprocessing || 0,
    discarded: byStatus.discarded || 0,
    byJobType: byType,
  }
}

export const resetDLQTable = (): void => {
  dlqTable.length = 0
}
