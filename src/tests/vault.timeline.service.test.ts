import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockAuditSelect = jest.fn<any>()
const mockTxSelect = jest.fn<any>()

jest.unstable_mockModule('../db/index.js', () => ({
  pool: { query: jest.fn<any>().mockResolvedValue({ rows: [] }) },
  db: jest.fn<any>((table: string) => {
    if (table === 'audit_logs') {
      return {
        where: jest.fn<any>().mockReturnThis(),
        select: mockAuditSelect,
      }
    }
    if (table === 'transactions') {
      return {
        where: jest.fn<any>().mockReturnThis(),
        select: mockTxSelect,
      }
    }
    return {
      where: jest.fn<any>().mockReturnThis(),
      select: jest.fn<any>().mockResolvedValue([]),
    }
  }),
  default: jest.fn<any>(() => ({})),
}))

const { VaultService } = await import('../services/vault.service.js')

describe('VaultService.getVaultTimeline', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns empty array when no audit logs or transactions exist', async () => {
    mockAuditSelect.mockResolvedValue([])
    mockTxSelect.mockResolvedValue([])

    const result = await VaultService.getVaultTimeline('vault_123')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it('merges and sorts audit logs and transactions chronologically (oldest first)', async () => {
    mockAuditSelect.mockResolvedValue([
      {
        action: 'vault.created',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        actor_user_id: 'user_abc',
        metadata: { creator: 'GTEST...', amount: '1000' },
      },
    ])
    mockTxSelect.mockResolvedValue([
      {
        type: 'stake' as any,
        stellar_timestamp: new Date('2026-01-02T00:00:00.000Z'),
        tx_hash: 'hash_123',
        amount: '500',
        asset_code: 'XLM',
        from_account: 'GFROM...',
        to_account: 'GTO...',
      },
    ])

    const result = await VaultService.getVaultTimeline('vault_123')
    expect(result).toHaveLength(2)
    expect(result[0].timestamp).toBe('2026-01-01T00:00:00.000Z')
    expect((result[0].data as any).action).toBe('vault.created')
    expect(result[1].timestamp).toBe('2026-01-02T00:00:00.000Z')
    expect((result[1].data as any).type).toBe('stake')
  })

  it('correctly interleaves items from both sources in chronological order', async () => {
    mockAuditSelect.mockResolvedValue([
      {
        action: 'vault.cancelled',
        created_at: new Date('2026-01-03T00:00:00.000Z'),
        actor_user_id: 'user_abc',
        metadata: { reason: 'User request' },
      },
      {
        action: 'vault.created',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        actor_user_id: 'user_abc',
        metadata: {},
      },
    ])
    mockTxSelect.mockResolvedValue([
      {
        type: 'release' as any,
        stellar_timestamp: new Date('2026-01-02T00:00:00.000Z'),
        tx_hash: 'h1',
        amount: '100',
        asset_code: null,
        from_account: 'GA',
        to_account: 'GB',
      },
    ])

    const result = await VaultService.getVaultTimeline('vault_456')
    expect(result).toHaveLength(3)
    expect((result[0].data as any).action).toBe('vault.created')
    expect((result[1].data as any).type).toBe('release')
    expect((result[2].data as any).action).toBe('vault.cancelled')
  })

  it('spreads audit log metadata into the timeline item data object', async () => {
    mockAuditSelect.mockResolvedValue([
      {
        action: 'vault.created',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        actor_user_id: 'user_xyz',
        metadata: { creator: 'GADDR1', amount: '5000', extra: true },      },
    ])
    mockTxSelect.mockResolvedValue([])

    const result = await VaultService.getVaultTimeline('vault_meta')
    expect(result).toHaveLength(1)
    expect((result[0].data as any).action).toBe('vault.created')
    expect((result[0].data as any).actor_user_id).toBe('user_xyz')
    expect((result[0].data as any).creator).toBe('GADDR1')
    expect((result[0].data as any).amount).toBe('5000')
    expect((result[0].data as any).extra).toBe(true)
  })

  it('preserves transaction fields (tx_hash, amount, accounts) in data', async () => {
    mockAuditSelect.mockResolvedValue([])
    mockTxSelect.mockResolvedValue([
      {
        type: 'creation' as any,
        stellar_timestamp: new Date('2026-06-15T12:00:00.000Z'),
        tx_hash: 'abcdef123456',
        amount: '250.0000000',
        asset_code: 'USDC',
        from_account: 'GFROMSACCOUNT',
        to_account: 'GTOSACCOUNT',
      },
    ])

    const [item] = await VaultService.getVaultTimeline('vault_tx')
    expect(item.timestamp).toBe('2026-06-15T12:00:00.000Z')
    expect((item.data as any).type).toBe('creation')
    expect((item.data as any).tx_hash).toBe('abcdef123456')
    expect((item.data as any).amount).toBe('250.0000000')
    expect((item.data as any).asset_code).toBe('USDC')
    expect((item.data as any).from_account).toBe('GFROMSACCOUNT')
    expect((item.data as any).to_account).toBe('GTOSACCOUNT')
  })

  it('scopes queries to the provided vault id', async () => {
    const mockAuditWhere = jest.fn<any>().mockReturnThis()
    const mockAuditWhereSelect = jest.fn<any>().mockResolvedValue([])
    const mockTxWhere = jest.fn<any>().mockReturnThis()
    const mockTxWhereSelect = jest.fn<any>().mockResolvedValue([])

    const dbMock = (table: string) => {
      if (table === 'audit_logs') {
        return { where: mockAuditWhere, select: mockAuditWhereSelect }
      }
      if (table === 'transactions') {
        return { where: mockTxWhere, select: mockTxWhereSelect }
      }
      return { where: jest.fn<any>().mockReturnThis(), select: jest.fn<any>().mockResolvedValue([]) }
    }

    jest.resetModules()
    jest.unstable_mockModule('../db/index.js', () => ({
      pool: { query: jest.fn<any>().mockResolvedValue({ rows: [] }) },
      db: dbMock,
      default: dbMock,
    }))

    const { VaultService: VaultServiceFresh } = await import('../services/vault.service.js')
    await VaultServiceFresh.getVaultTimeline('target_vault_999')

    expect(mockAuditWhere).toHaveBeenCalledWith({ target_type: 'vault', target_id: 'target_vault_999' })
    expect(mockTxWhere).toHaveBeenCalledWith({ vault_id: 'target_vault_999' })
  })
})
