export interface Vault {
    id: string
    creator: string
    amount: string
    startTimestamp: string
    endTimestamp: string
    successDestination: string
    failureDestination: string
    status: 'active' | 'completed' | 'failed' | 'cancelled'
    createdAt: string
    updatedAt: string
}

export interface VaultAnalytics {
    totalVaults: number
    activeVaults: number
    completedVaults: number
    failedVaults: number
    totalLockedCapital: string
    activeCapital: string
    successRate: number
    lastUpdated: string
}

export interface VaultAnalyticsWithPeriod extends VaultAnalytics {
    period: string
    startDate: string
    endDate: string
}

export interface TimeRangeFilter {
    period: '7d' | '30d' | '90d' | '1y' | 'all'
}

export interface VaultStatusUpdate {
    status: 'active' | 'completed' | 'failed' | 'cancelled'
}
